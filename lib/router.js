import { EmbedBuilder, MessageFlags } from 'discord.js'

import { isAuthorized } from './config.js'
import { TranslatableError, translator } from './i18n.js'
import { resolveAgent, runTurn } from './run.js'
import { findWorkspace, listWorkspaces, suggestDirectories } from './workspaces.js'
import { channelSlug, workspaceIdFromTopic } from './topology.js'
import * as render from './render.js'
import {
  createWorkspace,
  listSubagents,
  listWorkspaceSessions,
  newestSessionId,
  readLineage,
  readModelSelection,
  readOverview,
  readTimeline,
  readSessionStats,
  readTrajectory,
  resolveSessionId,
  shortId,
  switchModel,
} from './queries.js'

/** How long an autocomplete listing stays warm. Discord allows 3s per reply. */
const AUTOCOMPLETE_TTL_MS = 15_000
/** Discord's ceiling on autocomplete choices. */
const CHOICE_LIMIT = 25
/** Cache slot for the model catalog; workspaces key by their own id. */
const MODEL_CACHE_KEY = 'models'

/**
 * Route Discord interactions to harness reads.
 *
 * Two Discord constraints shape everything here. A command must be acknowledged
 * within three seconds, and reading a cold session decompresses a log — so
 * every command defers first and edits after. Autocomplete cannot defer at all,
 * which is why it answers from a short-lived cache and never blocks on a title
 * fold that has not happened yet.
 *
 * @param {object} args - router dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.logger - the plugin logger.
 * @param {() => Promise<object>} args.resync - re-run channel reconciliation.
 * @param {() => number} args.mappedCount - how many channels are mapped now.
 * @param {Map<string, {channelId: string}>} args.runs - in-flight runs, shared with the approval answerer.
 * @param {Map<string, object>} args.ownedAgents - agent handles this plugin resumed.
 * @returns {(interaction: object) => Promise<void>} the interaction handler.
 */
export function createRouter({ ctx, config, logger, resync, mappedCount, runs, ownedAgents }) {
  /** @type {Map<string, {at: number, sessions: object[]}>} */
  const cache = new Map()

  /**
   * Refresh one workspace's cached listing in the background.
   * @param {object} workspace - the channel's workspace.
   */
  function warm(workspace) {
    listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT)
      .then((sessions) => cache.set(workspace.id, { at: Date.now(), sessions }))
      .catch(() => {})
  }

  /**
   * Sessions for one workspace, with titles. Used by commands, which have
   * already deferred and can afford the title fold.
   * @param {object} workspace - the channel's workspace.
   * @returns {Promise<object[]>} session summaries.
   */
  async function cachedSessions(workspace) {
    const hit = cache.get(workspace.id)
    if (hit !== undefined) {
      if (Date.now() - hit.at >= AUTOCOMPLETE_TTL_MS) warm(workspace)
      return hit.sessions
    }

    const sessions = await listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT)
    cache.set(workspace.id, { at: Date.now(), sessions })
    return sessions
  }

  /**
   * Sessions for autocomplete, which cannot defer and must answer within three
   * seconds. A warm cache is used as-is, stale or not. A cold one falls back to
   * the title-less listing — ids and liveness only, from session metadata that
   * opens no logs — and warms the full listing in the background, so the next
   * keystroke shows titles. Waiting for a cold title fold here would decompress
   * a log per session and blow the deadline, which Discord reports to the user
   * as no suggestions at all.
   * @param {object} workspace - the channel's workspace.
   * @returns {Promise<object[]>} session summaries, possibly without titles.
   */
  async function suggestibleSessions(workspace) {
    const hit = cache.get(workspace.id)
    if (hit !== undefined) {
      if (Date.now() - hit.at >= AUTOCOMPLETE_TTL_MS) warm(workspace)
      return hit.sessions
    }

    warm(workspace)
    return listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT, { titles: false })
  }

  /**
   * The workspace a channel stands for. The topic anchor is authoritative: it
   * survives a restart, a rename, and a bot redeploy, none of which in-memory
   * state does.
   * @param {object} interaction - the Discord interaction.
   * @returns {Promise<object>} the workspace view.
   */
  async function workspaceForChannel(interaction) {
    const topic = interaction.channel?.topic
    const workspaceId = workspaceIdFromTopic(topic)
    if (workspaceId === undefined) {
      throw new TranslatableError('error.unmappedChannel', { category: config.categoryName })
    }

    const workspace = await findWorkspace(ctx, workspaceId)
    if (workspace === undefined) {
      throw new TranslatableError('error.goneWorkspace')
    }
    return workspace
  }

  /**
   * Resolve the session a command targets: the given reference, or the
   * workspace's newest session when the option was omitted.
   * @param {object} interaction - the Discord interaction.
   * @param {object} workspace - the channel's workspace.
   * @returns {Promise<object>} a session summary for the target.
   */
  async function targetSession(interaction, workspace) {
    const given = interaction.options.getString('session')
    const id = given === null
      ? await newestSessionId(ctx, workspace)
      : await resolveSessionId(ctx, workspace, given)

    const sessions = await cachedSessions(workspace)
    const known = sessions.find((entry) => entry.id === id)
    return known ?? { id, short: shortId(id), title: undefined }
  }

  /**
   * Deliver a prompt to the workspace's agent and follow the turn.
   *
   * The run is registered in `runs` for its whole duration: that map is what
   * lets the approval answerer recognize a question as belonging to a turn
   * this channel started, and route its card back here.
   *
   * @param {object} interaction - the deferred command interaction.
   * @param {object} workspace - the channel's workspace.
   * @param {string} prompt - the user's prompt.
   * @returns {Promise<object>} the final reply payload.
   */
  async function startRun({ workspace, prompt, channelId, post, t }) {
    const sessions = await listWorkspaceSessions(ctx, workspace, 25)
    const agent = await resolveAgent(ctx, sessions, ownedAgents, workspace, logger)
    const sessionId = String(agent.session.id)
    const short = sessionId.replace(/^session-/, '').slice(0, 8)

    /**
     * Render one status frame.
     * @param {string} text - the rendered body.
     * @returns {object} an embed payload.
     */
    const frame = (text) => ({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`⚙️ ${workspace.title}`)
        .setDescription(text.slice(0, 4000))
        .setFooter({ text: `session ${short}` })],
    })

    const report = async (text) => post(frame(text))

    runs.set(sessionId, { channelId })
    try {
      await report(`> ${prompt.slice(0, 300)}\n\n${t('run.starting')}`)
      await runTurn({ ctx, agent, prompt, report, logger, verbosity: config.runVerbosity, t })
    } finally {
      runs.delete(sessionId)
    }
  }

  /**
   * Run a prompt from a slash command, reporting into its deferred reply.
   * @param {object} interaction - the deferred command interaction.
   * @param {object} workspace - the channel's workspace.
   * @param {string} prompt - the user's prompt.
   * @returns {Promise<undefined>} nothing; the reply is written as it goes.
   */
  async function runWorkspacePrompt(interaction, workspace, prompt, t) {
    await startRun({
      workspace,
      prompt,
      t,
      channelId: interaction.channelId,
      // Discord stops accepting edits to an interaction response after about
      // fifteen minutes, so a long turn falls back to ordinary channel
      // messages rather than losing its output entirely.
      post: async (payload) => {
        try {
          await interaction.editReply(payload)
        } catch {
          await interaction.channel?.send(payload)
        }
      },
    })
    return undefined
  }

  /**
   * Handle one slash command, after authorization and deferral.
   * @param {object} interaction - the Discord interaction.
   * @returns {Promise<object>} the reply payload.
   */
  async function dispatch(interaction, t) {
    const sub = interaction.options.getSubcommand()

    if (sub === 'help') {
      return render.renderHelp({
        categoryName: config.categoryName,
        allowRun: config.allowRun,
        chatMode: config.listenToMessages,
      }, t)
    }

    if (sub === 'status') {
      const [overview, workspaces] = await Promise.all([readOverview(ctx), listWorkspaces(ctx)])
      return render.renderStatus(overview, workspaces, { categoryName: config.categoryName, mapped: mappedCount() }, t)
    }

    if (sub === 'sync') {
      const result = await resync()
      const privacy = {
        enforced: t('sync.private'),
        external: t('sync.privateExternal'),
        open: t('sync.notPrivate'),
      }[result.privacy] ?? t('sync.notPrivate')

      const parts = [
        t('sync.mapped', { count: result.mapping.size }),
        privacy,
        result.created.length > 0 ? t('sync.created', { channels: result.created.map((name) => `#${name}`).join(', ') }) : undefined,
        result.orphans.length > 0 ? t('sync.orphans', { count: result.orphans.length }) : undefined,
        result.skipped.length > 0 ? t('sync.skipped', { count: result.skipped.length }) : undefined,
        result.invisible?.length > 0
          ? t('sync.invisible', { channels: result.invisible.map((name) => `#${name}`).join(', ') })
          : undefined,
      ].filter(Boolean)
      return { content: `🔄 ${parts.join(' · ')}` }
    }

    // The two write commands. Neither is workspace-scoped, so both run before a
    // channel has to resolve to one — `/dsh workspace` is precisely what you
    // run when no channel exists yet.
    if (sub === 'model') {
      const to = interaction.options.getString('to')
      if (to === null) return render.renderModel(await readModelSelection(ctx), t)
      return render.renderModelSwitched(await switchModel(ctx, to), t)
    }

    if (sub === 'workspace') {
      const workspace = await createWorkspace(ctx, interaction.options.getString('path'))
      // Give it a channel immediately: a registration with no visible channel
      // reads as a failure, and the channel is the thing the user came for.
      const result = await resync().catch(() => undefined)
      const mapped = result !== undefined && [...result.mapping.values()].includes(workspace.id)
      return render.renderWorkspaceCreated(workspace, mapped ? channelSlug(workspace.title) : undefined, t)
    }

    const workspace = await workspaceForChannel(interaction)

    if (sub === 'run') {
      if (!config.allowRun) throw new TranslatableError('run.disabled')
      return runWorkspacePrompt(interaction, workspace, interaction.options.getString('prompt'), t)
    }

    if (sub === 'sessions') {
      const requested = interaction.options.getInteger('limit') ?? config.sessionLimit
      const sessions = await listWorkspaceSessions(ctx, workspace, requested)
      cache.set(workspace.id, { at: Date.now(), sessions: sessions.slice(0, CHOICE_LIMIT) })
      return render.renderSessions(workspace, sessions, t)
    }

    const target = await targetSession(interaction, workspace)

    if (sub === 'trace') {
      const [trajectory, stats] = await Promise.all([
        readTrajectory(ctx, target.id, {
          limit: interaction.options.getInteger('limit') ?? config.traceLimit,
          everything: interaction.options.getBoolean('everything') ?? false,
        }),
        readSessionStats(ctx, target.id),
      ])
      return render.renderTrajectory(target, trajectory, t, stats)
    }

    if (sub === 'timeline') {
      const [timeline, stats] = await Promise.all([
        readTimeline(ctx, target.id, { limit: interaction.options.getInteger('limit') ?? config.traceLimit }),
        readSessionStats(ctx, target.id),
      ])
      return render.renderTimeline(target, timeline, t, stats)
    }

    if (sub === 'subagents') {
      const deep = interaction.options.getBoolean('deep') ?? false
      const entries = await listSubagents(ctx, target.id, { deep })
      return render.renderSubagents(target, entries, deep, t)
    }

    if (sub === 'lineage') {
      const lineage = await readLineage(ctx, target.id)
      return render.renderLineage(target, lineage, t)
    }

    throw new TranslatableError('error.unknownSubcommand', { sub })
  }

  /**
   * Model choices for `/dsh model`, cached like the session listing because
   * a provider catalog may be an adapter call and autocomplete cannot defer.
   * @param {string} typed - what the user has typed so far.
   * @returns {Promise<object[]>} Discord choice objects.
   */
  async function modelChoices(typed) {
    const hit = cache.get(MODEL_CACHE_KEY)
    let models = hit?.sessions

    if (models === undefined || Date.now() - hit.at >= AUTOCOMPLETE_TTL_MS) {
      const selection = await readModelSelection(ctx)
      models = selection.models.length > 0 ? selection.models : [{ id: selection.current.model, name: selection.current.model }]
      cache.set(MODEL_CACHE_KEY, { at: Date.now(), sessions: models })
    }

    return models
      .filter((model) => typed.length === 0 || model.id.toLowerCase().includes(typed))
      .slice(0, CHOICE_LIMIT)
      .map((model) => ({ name: `${model.id}${model.description === undefined ? '' : ` — ${model.description}`}`.slice(0, 100), value: model.id }))
  }

  /**
   * Answer an autocomplete request, for whichever option has focus.
   * @param {object} interaction - the autocomplete interaction.
   * @returns {Promise<void>} resolution once choices are sent.
   */
  async function autocomplete(interaction) {
    // Suggestions leak real information — session titles, and for `path` the
    // directory names on this machine — so the same allowlist that gates the
    // commands gates the hints. An empty list is what an unauthorized user sees.
    if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
      await interaction.respond([])
      return
    }

    const focused = interaction.options.getFocused(true)
    const typed = String(focused.value ?? '').toLowerCase()
    let choices = []

    try {
      if (focused.name === 'to') {
        await interaction.respond(await modelChoices(typed))
        return
      }

      if (focused.name === 'path') {
        const known = await listWorkspaces(ctx)
        const paths = await suggestDirectories(String(focused.value ?? ''), known, CHOICE_LIMIT)
        await interaction.respond(paths.map((path) => ({
          // Discord caps a choice name at 100 characters; keep the tail, which
          // is the part that distinguishes one project directory from another.
          name: path.length <= 100 ? path : `…${path.slice(-99)}`,
          value: path,
        })))
        return
      }

      const workspace = await workspaceForChannel(interaction)
      const sessions = await suggestibleSessions(workspace)
      choices = sessions
        .filter((entry) => typed.length === 0
          || entry.short.startsWith(typed)
          || (entry.title ?? '').toLowerCase().includes(typed))
        .slice(0, CHOICE_LIMIT)
        .map((entry) => ({
          name: `${entry.live ? '🟢 ' : ''}${entry.short} · ${(entry.title ?? 'untitled').slice(0, 80)}`.slice(0, 100),
          value: entry.short,
        }))
    } catch {
      // An unmapped channel or a cold corpus yields no suggestions; the user
      // can still type an id. Autocomplete must never surface an error.
      choices = []
    }

    await interaction.respond(choices)
  }

  /**
   * Treat an ordinary channel message as work for that workspace's agent.
   *
   * Every rejection here is silent. This handler sees every message in the
   * guild, so replying to the ones it declines would turn an unrelated
   * conversation into a stream of refusals — and telling an unauthorized member
   * that they are unauthorized tells them the bot is worth probing. The one
   * exception is a failure *after* the run was accepted, which the author is
   * waiting on.
   *
   * @param {object} message - the Discord message.
   * @returns {Promise<void>} resolution once the message is handled or ignored.
   */
  async function handleMessage(message) {
    if (config.listenToMessages === 'off' || !config.allowRun) return
    if (message.author?.bot === true || message.guildId !== config.guildId) return

    const selfId = message.client?.user?.id
    const mentioned = selfId !== undefined && message.mentions?.users?.has(selfId) === true
    if (config.listenToMessages === 'mention' && !mentioned) return

    // Slash commands arrive as interactions; a line that merely starts with a
    // slash is someone typing, not a command for us.
    if (message.content?.startsWith('/')) return

    if (!isAuthorized(config, message.author.id, message.guild?.ownerId)) return

    const t = translator(config.language, message.guild?.preferredLocale)

    let workspace
    try {
      workspace = await workspaceForChannel(message)
    } catch {
      return
    }

    const prompt = String(message.content ?? '')
      .replace(new RegExp(`<@!?${selfId}>`, 'g'), '')
      .trim()
    if (prompt.length === 0) return

    let status
    try {
      status = await message.reply({ content: t('run.reading') })
    } catch {
      return
    }

    try {
      await startRun({
        workspace,
        prompt,
        t,
        channelId: message.channelId,
        post: async (payload) => { await status.edit({ content: null, ...payload }) },
      })
    } catch (error) {
      logger.warn('dsh-discord-bot: chat run failed: %s', error instanceof Error ? error.message : error)
      await status.edit({ content: null, ...render.renderError(error, t) }).catch(() => {})
    }
  }

  /**
   * Handle one Discord interaction: a slash command or an autocomplete.
   * @param {object} interaction - the Discord interaction.
   * @returns {Promise<void>} resolution once the interaction is answered.
   */
  async function handleInteraction(interaction) {
    if (interaction.guildId !== config.guildId) return

    if (interaction.isAutocomplete()) {
      try {
        await autocomplete(interaction)
      } catch (error) {
        logger.debug('autocomplete failed: %s', error instanceof Error ? error.message : error)
      }
      return
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'dsh') return

    const t = translator(config.language, interaction.locale)

    const ownerId = interaction.guild?.ownerId
    if (!isAuthorized(config, interaction.user.id, ownerId)) {
      await interaction.reply({ content: t('error.notAllowed'), flags: MessageFlags.Ephemeral })
      return
    }

    // Every branch below reads the harness, and a cold session read outlives
    // the three-second acknowledgement window.
    await interaction.deferReply()

    try {
      // `/dsh run` writes its own reply as the turn progresses and returns
      // nothing; every other command returns one payload to post here.
      const payload = await dispatch(interaction, t)
      if (payload !== undefined) await interaction.editReply(payload)
    } catch (error) {
      logger.warn('/dsh %s failed: %s', interaction.options.getSubcommand(false) ?? '?', error instanceof Error ? error.message : error)
      await interaction.editReply(render.renderError(error, t)).catch(() => {})
    }
  }

  return { handleInteraction, handleMessage }
}
