import { format } from 'node:util'

import { Client, Events, GatewayIntentBits } from 'discord.js'

import { installApprovalAnswerer } from './approval.js'
import { normalizeConfig, resolveToken } from './config.js'
import { publishCommands } from './commands.js'
import { createRouter } from './router.js'
import { reconcile } from './topology.js'
import { listWorkspaces } from './workspaces.js'

/** Coalescing window for reconciles triggered by session lifecycle events. */
const RECONCILE_DEBOUNCE_MS = 5_000
/** Floor between two automatic reconciles, so a session burst cannot spam the API. */
const RECONCILE_FLOOR_MS = 30_000

/**
 * Resolve the context's logger, in whatever shape it takes.
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {object | undefined} something with warn/info/debug, when present.
 */
function upstreamLogger(ctx) {
  const logger = ctx.logger
  if (logger !== undefined && typeof logger.warn === 'function') return logger
  if (typeof logger === 'function') {
    try {
      const named = logger('dsh-discord-bot')
      if (named !== undefined && typeof named.warn === 'function') return named
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * A logger that writes to the harness logger *and* to stderr.
 *
 * Cordis discards log records when no exporter is registered, and the web
 * profile registers none — so a token typo or a missing permission would be
 * swallowed entirely, leaving an operator with a bot that is simply absent and
 * no way to find out why. These are startup and failure lines, a handful per
 * run, and stderr keeps them clear of the URL line the shell owns on stdout.
 * `debug` stays upstream-only, because that one is not a handful.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {object} the dual-writing logger.
 */
function loggerFor(ctx) {
  const upstream = upstreamLogger(ctx)

  const emit = (level, ...args) => {
    try {
      upstream?.[level]?.(...args)
    } catch {
      // an upstream logging fault must not break the caller
    }
    if (level !== 'debug') process.stderr.write(`${format(...args)}\n`)
  }

  return {
    info: (...args) => emit('info', ...args),
    warn: (...args) => emit('warn', ...args),
    error: (...args) => emit('error', ...args),
    debug: (...args) => emit('debug', ...args),
  }
}

/**
 * The live bridge between one harness and one Discord guild. A plain class,
 * not a Cordis `Service`: see `config.js` for why this package imports nothing
 * from the harness's own modules.
 */
class DiscordBridge {
  /** @type {import('discord.js').Client | undefined} */
  client
  /** @type {Map<string, string>} */
  mapping = new Map()
  /** Sessions this plugin is driving right now, keyed by session id. */
  runs = new Map()
  /** Agent handles this plugin resumed; nobody else will dispose them. */
  ownedAgents = new Map()
  /** @type {NodeJS.Timeout | undefined} */
  retryTimer
  /** @type {NodeJS.Timeout | undefined} */
  reconcileTimer
  /** Wall-clock of the last completed reconcile, for the rate floor. */
  lastReconcileAt = 0
  /** Set on disposal so an in-flight retry stops rescheduling itself. */
  stopped = false

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = loggerFor(ctx)
  }

  /**
   * Begin connecting, without blocking activation.
   *
   * Nothing here may throw into the caller. Cordis treats an activation failure
   * as a failed composition, so an expired token or a plane flight would stop
   * dsh from booting at all — for a plugin whose whole job is optional remote
   * visibility, that trade is plainly wrong. Failures log and retry instead.
   */
  start() {
    const token = resolveToken(this.config)
    if (token === undefined) {
      this.logger.warn('dsh-discord-bot: no token configured — set `token`, `tokenFile`, or DSH_DISCORD_BOT_TOKEN; staying offline')
      return
    }

    this.installSessionWatch()

    // Installed only when running work is enabled: with `allowRun` off there is
    // never an entry in `runs`, so the answerer would delegate every question
    // anyway — not installing it keeps the waterfall honest about who answers.
    if (this.config.allowRun) {
      installApprovalAnswerer({
        ctx: this.ctx,
        config: this.config,
        logger: this.logger,
        client: () => this.client,
        runs: this.runs,
      })
    }

    void this.connect(token)
  }

  /**
   * Build a client, wire it, and log in; reschedule on failure.
   * @param {string} token - the resolved bot token.
   * @returns {Promise<void>} resolution once login settles.
   */
  async connect(token) {
    if (this.stopped) return

    // Slash commands and channel management need only the Guilds intent.
    // Message Content is privileged and is requested *only* when chat mode is
    // configured — asking for an intent the application has not enabled makes
    // Discord refuse the connection outright, so a bot that always asked would
    // be offline for every operator who never wanted chat in the first place.
    const intents = [GatewayIntentBits.Guilds]
    if (this.config.listenToMessages !== 'off') {
      intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent)
    }

    const client = new Client({ intents })
    this.client = client

    const router = createRouter({
      ctx: this.ctx,
      config: this.config,
      logger: this.logger,
      resync: () => this.reconcileNow(),
      mappedCount: () => this.mapping.size,
      runs: this.runs,
      ownedAgents: this.ownedAgents,
    })

    client.on(Events.InteractionCreate, (interaction) => {
      void router.handleInteraction(interaction).catch((error) => {
        this.logger.warn('dsh-discord-bot: interaction failed: %s', described(error))
      })
    })

    if (this.config.listenToMessages !== 'off') {
      client.on(Events.MessageCreate, (message) => {
        void router.handleMessage(message).catch((error) => {
          this.logger.warn('dsh-discord-bot: message handling failed: %s', described(error))
        })
      })
    }

    // discord.js emits 'error' for transport faults it recovers from itself.
    // Leaving it unhandled would turn a dropped WebSocket into a process exit.
    client.on(Events.Error, (error) => {
      this.logger.warn('dsh-discord-bot: client error: %s', error.message)
    })

    client.once(Events.ClientReady, (ready) => {
      this.logger.info('dsh-discord-bot: connected as %s', ready.user.tag)
      void this.onReady()
    })

    try {
      await client.login(token)
    } catch (error) {
      const detail = described(error)
      this.client = undefined
      void client.destroy().catch(() => {})

      // A rejected privileged intent will be rejected identically forever, so
      // retrying is just a log flood. Stop, and say exactly which of the two
      // fixes applies.
      if (/disallowed intents/i.test(detail)) {
        this.logger.error('dsh-discord-bot: Discord refused the Message Content intent. Enable it under Bot → Privileged Gateway Intents in the Developer Portal, or set `listenToMessages: off` in the plugin row. Not retrying.')
        return
      }

      this.logger.warn('dsh-discord-bot: login failed (%s); retrying in %ds', detail, this.config.retrySeconds)
      this.scheduleRetry(token)
    }
  }

  /**
   * Publish commands and lay out the category once the gateway is up. Both
   * steps are best-effort: a missing permission should cost the feature that
   * needs it, not the connection.
   * @returns {Promise<void>} resolution once startup work settles.
   */
  async onReady() {
    try {
      await publishCommands(this.client, this.config.guildId)
    } catch (error) {
      this.logger.warn('dsh-discord-bot: could not publish slash commands: %s', described(error))
    }

    try {
      const result = await this.reconcileNow()
      this.logger.info('dsh-discord-bot: %d workspace channel(s) mapped under "%s"', result.mapping.size, this.config.categoryName)
    } catch (error) {
      this.logger.warn('dsh-discord-bot: initial channel sync failed: %s', described(error))
    }
  }

  /**
   * Re-derive the workspace-to-channel mapping against Discord.
   * @returns {Promise<object>} the reconcile result.
   */
  async reconcileNow() {
    if (this.client === undefined) throw new Error('the bot is not connected to Discord')

    const workspaces = await listWorkspaces(this.ctx)
    const result = await reconcile({
      client: this.client,
      config: this.config,
      workspaces,
      logger: this.logger,
    })

    this.mapping = result.mapping
    this.lastReconcileAt = Date.now()
    return result
  }

  /**
   * Track session lifecycle so a workspace created after boot gets a channel.
   *
   * The workspace registry publishes no change event, so session creation is
   * the observable proxy — debounced, and floored, because one agent run can
   * create several sessions in a second and each reconcile costs guild fetches.
   */
  installSessionWatch() {
    if (!this.config.followNewWorkspaces) return

    this.ctx.on('session/created', () => {
      if (this.client === undefined || this.reconcileTimer !== undefined) return

      const sinceLast = Date.now() - this.lastReconcileAt
      const delay = Math.max(RECONCILE_DEBOUNCE_MS, RECONCILE_FLOOR_MS - sinceLast)

      this.reconcileTimer = setTimeout(() => {
        this.reconcileTimer = undefined
        this.reconcileNow().catch((error) => {
          this.logger.debug('dsh-discord-bot: background sync failed: %s', described(error))
        })
      }, delay)
    })
  }

  /**
   * Queue another login attempt.
   * @param {string} token - the resolved bot token.
   */
  scheduleRetry(token) {
    if (this.stopped || this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect(token)
    }, this.config.retrySeconds * 1000)
  }

  /**
   * Tear down every side effect this bridge owns: pending timers first, so a
   * retry cannot resurrect the client after disposal, then the connection.
   * @returns {Promise<void>} resolution once the gateway is closed.
   */
  async shutdown() {
    this.stopped = true

    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer)
    this.retryTimer = undefined
    this.reconcileTimer = undefined

    // Release the agents this plugin resumed. Each handle is a consumer
    // capability we own; leaving them behind would keep loops and their scoped
    // worlds alive after the bridge that asked for them is gone.
    const handles = [...this.ownedAgents.values()]
    this.ownedAgents.clear()
    this.runs.clear()
    await Promise.all(handles.map((handle) => handle.dispose?.().catch(() => {})))

    const client = this.client
    this.client = undefined
    if (client !== undefined) await client.destroy().catch(() => {})
  }
}

/** @param {unknown} error - a thrown value. @returns {string} a loggable description. */
function described(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Projects this harness onto one Discord guild: a category holding one text
 * channel per workspace, and `/dsh …` commands that read session trajectories
 * and live subagents from inside those channels.
 *
 * The traversal property this exists for is a consequence of the gateway, not
 * a tunnel: the bot dials *out* over a WebSocket, so a harness behind NAT,
 * CGNAT, or a corporate firewall is reachable from a phone with no port
 * forwarded, no dynamic DNS, and no third-party relay holding a key to the box.
 *
 * The bot is read-only by construction. It answers questions about sessions; it
 * cannot start one, steer one, or run a tool. Exporting private session content
 * to a chat platform is already a real trust decision, and pairing that with
 * remote execution would make one compromised Discord account a shell.
 *
 * `sessionQuery` is the one hard dependency — without it there is nothing to
 * answer. `workspaceRegistry` and `subagents` are read through `ctx.get()`,
 * because the tui and headless profiles legitimately omit the first and the
 * bot degrades to cwd-grouped workspaces rather than failing to mount.
 */
export const plugin = {
  name: 'dsh-discord-bot',
  inject: ['sessionQuery'],

  apply(ctx, config) {
    const validated = normalizeConfig(config)
    const bridge = new DiscordBridge(ctx, validated)

    // Registered before the connection starts: a composition disposed mid-login
    // must still be able to close the socket it is about to own.
    ctx.effect(() => () => bridge.shutdown(), 'dsh-discord-bot.client')
    bridge.start()
  },
}

export default plugin
