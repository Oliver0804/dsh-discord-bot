import { ActionRowBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'

import { isAuthorized } from './config.js'
import { actionButtons, decodeAction, isActionInteraction } from './actions.js'
import { readAttachments } from './attachments.js'
import { TranslatableError, translator } from './i18n.js'
import { preferRunning, resolveAgent, rewindPoints, rewindSession, runTurn, userMessage } from './run.js'
import { answerQuestionModal, QUESTION_MODAL_PREFIX } from './questions.js'
import { findWorkspace, listWorkspaces, suggestDirectories } from './workspaces.js'
import { applyMenu, closedMenu, decodeMenu, isMenuInteraction, openMenu } from './menu.js'
import { channelSlug, workspaceIdFromTopic } from './topology.js'
import * as render from './render.js'
import { described } from './util.js'
import {
  cancelSession,
  createWorkspace,
  exportSession,
  listSubagents,
  listWorkspaceSessions,
  listHarnessCommands,
  newestSessionId,
  readAgentContext,
  readAgentPresets,
  readLineage,
  readModelSelection,
  readOverview,
  readPermissionPresets,
  readTimeline,
  readSessionStats,
  readTodos,
  readTrajectory,
  resolveSessionId,
  runHarnessCommand,
  searchWorkspaceSessions,
  shortId,
  switchAgentPreset,
  switchModel,
  switchPermissionPreset,
} from './queries.js'

/** How long an autocomplete listing stays warm. Discord allows 3s per reply. */
const AUTOCOMPLETE_TTL_MS = 15_000
/** Discord's ceiling on autocomplete choices. */
const CHOICE_LIMIT = 25
/** Cache slot for the model catalog; workspaces key by their own id. */
const MODEL_CACHE_KEY = 'models'
/** Cache slot for the agent preset roster. */
const PRESET_CACHE_KEY = 'presets'
/** Cache slot for the harness's own command registry. */
const COMMAND_CACHE_KEY = 'harness-commands'

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
 * @param {object} [args.activity] - the live-status tracker.
 * @returns {(interaction: object) => Promise<void>} the interaction handler.
 */
export function createRouter({ ctx, config, logger, resync, mappedCount, runs, ownedAgents, activity }) {
  /**
   * Autocomplete warm cache: one slot per workspace (keyed by its id) plus one
   * shared slot for the model catalog (`MODEL_CACHE_KEY`). Both store the same
   * shape — a timestamp and a list of items — because neither can afford a
   * cold read inside Discord's three-second autocomplete window.
   * @type {Map<string, {at: number, items: object[]}>}
   */
  const cache = new Map()

  /**
   * Refresh one workspace's cached listing in the background.
   * @param {object} workspace - the channel's workspace.
   */
  function warm(workspace) {
    listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT)
      .then((sessions) => cache.set(workspace.id, { at: Date.now(), items: sessions }))
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
      return hit.items
    }

    const sessions = await listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT)
    cache.set(workspace.id, { at: Date.now(), items: sessions })
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
      return hit.items
    }

    warm(workspace)
    return listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT, { titles: false })
  }

  /**
   * The harness commands available to this workspace, without causing any.
   *
   * The registry lists per agent, and the only agent this may read is one that
   * is already live: resuming a cold session to answer "what commands exist"
   * would make a read cause work, and autocomplete cannot afford it either.
   * With none live the last listing stands in — the registry rarely changes,
   * and a stale list is better than an empty picker.
   *
   * @param {object} workspace - the channel's workspace.
   * @returns {Promise<object[]>} command descriptors, possibly stale or empty.
   */
  async function harnessCommands(workspace) {
    const hit = cache.get(COMMAND_CACHE_KEY)
    if (hit !== undefined && Date.now() - hit.at < AUTOCOMPLETE_TTL_MS) return hit.items

    const sessions = await listWorkspaceSessions(ctx, workspace, CHOICE_LIMIT, { titles: false })
    const agents = ctx.get('agents')
    const live = sessions.map((entry) => agents?.get(entry.id)).find((agent) => agent !== undefined)
    if (live === undefined) return hit?.items ?? []

    const items = listHarnessCommands(ctx, live)
    cache.set(COMMAND_CACHE_KEY, { at: Date.now(), items })
    return items
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
  async function startRun({ workspace, prompt, channelId, post, t, blocks = [] }) {
    const sessions = await listWorkspaceSessions(ctx, workspace, 25)
    // A workspace can have two live agents; the one to talk to is the one
    // working. Without this, steering would land on whichever happens to be
    // newest and the running turn would carry on unaware.
    const agent = await resolveAgent(ctx, preferRunning(sessions, activity), ownedAgents, workspace, logger)
    const sessionId = String(agent.session.id)
    const short = shortId(sessionId)

    // A turn is already running in this session — started at the machine, or
    // by whoever typed a moment before. Steering lands the text at that turn's
    // next step boundary instead of queueing a whole new turn behind it, which
    // is what a person interrupting a conversation means.
    //
    // Deliberately not registered in `runs` and not followed with `runTurn`:
    // this turn belongs to someone else. `whenIdle()` would settle on their
    // work and report it as this reply's, and claiming the session here would
    // also route their approval questions to this channel and silence the
    // mirror that is already showing them.
    if (activity?.isRunning(sessionId)) {
      agent.steer(userMessage(prompt, blocks))
      await post(render.renderSteered({ short, prompt }, t))
      return
    }

    /**
     * Render one status frame.
     * @param {string} text - the rendered body.
     * @param {boolean} done - whether this is the turn's closing frame; a
     *   finished card drops the steer and stop buttons, which only act on work
     *   still in flight.
     * @returns {object} an embed payload.
     */
    const frame = (text, done = false) => ({
      embeds: [new EmbedBuilder()
        .setColor(done ? 0x57f287 : 0x5865f2)
        .setTitle(`⚙️ ${workspace.title}`)
        .setDescription(text.slice(0, 4000))
        .setFooter({ text: `session ${short}` })],
      components: actionButtons(short, { allowRun: config.allowRun, done, t }),
    })

    const report = async (text, { done = false } = {}) => post(frame(text, done))

    runs.set(sessionId, { channelId })
    try {
      await report(`> ${prompt.slice(0, 300)}\n\n${t('run.starting')}`)
      await runTurn({ ctx, agent, prompt, blocks, report, logger, verbosity: config.runVerbosity, t })
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
        mirror: config.mirror,
      }, t)
    }

    if (sub === 'status') {
      const [overview, workspaces] = await Promise.all([readOverview(ctx), listWorkspaces(ctx)])
      return render.renderStatus(overview, workspaces, {
        categoryName: config.categoryName,
        mapped: mappedCount(),
        running: activity?.runningCount(),
      }, t)
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

    // The preset and permission switches are gated on `allowRun` even though
    // neither runs anything itself. Both decide what a later turn is allowed to
    // do — which tools it is composed with, and whether its bash calls are
    // sandboxed or approved — so someone who cannot start work here must not be
    // able to widen what work started at the machine may do. Reading them is
    // ungated: seeing the current posture is what the read surface is for.
    if (sub === 'preset') {
      const to = interaction.options.getString('to')
      if (to === null) return render.renderPresets(await readAgentPresets(ctx), t)
      if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
      return render.renderPresetSwitched(await switchAgentPreset(ctx, to), t)
    }

    if (sub === 'permission') {
      const to = interaction.options.getString('to')
      const given = interaction.options.getString('session')
      const sessionId = given === null
        ? undefined
        : await resolveSessionId(ctx, await workspaceForChannel(interaction), given)

      if (to === null) return render.renderPermissions(await readPermissionPresets(ctx, sessionId), t)
      if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
      return render.renderPermissionSwitched(await switchPermissionPreset(ctx, to, sessionId), t)
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

    if (sub === 'menu') {
      return openMenu({ ctx, config, workspace, mapped: mappedCount(), t })
    }

    if (sub === 'cmd') {
      const name = interaction.options.getString('name')
      if (name === null) return render.renderHarnessCommands(await harnessCommands(workspace), t)

      // A harness command runs a handler against the session: `/compact`
      // rewrites its history, `/plan` changes what the next turn may do. That
      // is the same class of effect `allowRun` gates, not a read.
      if (!config.allowRun) throw new TranslatableError('error.writeDisabled')

      const sessions = await listWorkspaceSessions(ctx, workspace, 25)
      const agent = await resolveAgent(ctx, sessions, ownedAgents, workspace, logger)
      const result = await runHarnessCommand(ctx, agent, name, interaction.options.getString('input') ?? undefined)
      // The registry may have gained or lost commands as a result; the next
      // listing re-reads rather than serving what this call was built from.
      cache.delete(COMMAND_CACHE_KEY)
      return render.renderHarnessCommandResult(result, t)
    }

    if (sub === 'run') {
      if (!config.allowRun) throw new TranslatableError('run.disabled')
      return runWorkspacePrompt(interaction, workspace, interaction.options.getString('prompt'), t)
    }

    if (sub === 'sessions') {
      const requested = interaction.options.getInteger('limit') ?? config.sessionLimit
      const sessions = await listWorkspaceSessions(ctx, workspace, requested)
      cache.set(workspace.id, { at: Date.now(), items: sessions.slice(0, CHOICE_LIMIT) })
      return render.renderSessions(workspace, sessions, t)
    }

    if (sub === 'search') {
      const query = interaction.options.getString('query')
      const requested = interaction.options.getInteger('limit') ?? 15
      const results = await searchWorkspaceSessions(ctx, workspace, query, { limit: requested })
      return render.renderSearchResults(workspace, query, results, t)
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

    if (sub === 'stop') {
      // Stopping is not a read: it ends work someone may be watching happen at
      // the machine. Same gate as starting it.
      if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
      return render.renderStopped(cancelSession(ctx, target.id), t)
    }

    if (sub === 'rewind') {
      // Rewinding mints a new agent that continues the conversation; the same
      // gate as anything else that can cause work.
      if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
      const agent = ctx.get('agents')?.get(target.id)
      if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short: target.short })
      return render.renderRewindCard(target, rewindPoints(agent), t)
    }

    if (sub === 'context') {
      return render.renderAgentContext(await readAgentContext(ctx, target.id), t)
    }

    if (sub === 'export') {
      return render.renderExport(target, await exportSession(ctx, target.id), t)
    }

    if (sub === 'todos') {
      const todos = readTodos(ctx, target.id)
      if (todos === undefined) throw new TranslatableError('error.sessionNotLive', { short: target.short })
      return render.renderTodos(target, todos, t)
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
    let models = hit?.items

    if (models === undefined || Date.now() - hit.at >= AUTOCOMPLETE_TTL_MS) {
      const selection = await readModelSelection(ctx)
      models = selection.models.length > 0 ? selection.models : [{ id: selection.current.model, name: selection.current.model }]
      cache.set(MODEL_CACHE_KEY, { at: Date.now(), items: models })
    }

    return models
      .filter((model) => typed.length === 0 || model.id.toLowerCase().includes(typed))
      .slice(0, CHOICE_LIMIT)
      .map((model) => ({ name: `${model.id}${model.description === undefined ? '' : ` — ${model.description}`}`.slice(0, 100), value: model.id }))
  }

  /**
   * Preset choices for `/dsh preset`, cached because `list()` re-scans the
   * preset roots on every call and autocomplete cannot defer.
   * @param {string} typed - what the user has typed so far.
   * @returns {Promise<object[]>} Discord choice objects.
   */
  async function presetChoices(typed) {
    const hit = cache.get(PRESET_CACHE_KEY)
    let presets = hit?.items

    if (presets === undefined || Date.now() - hit.at >= AUTOCOMPLETE_TTL_MS) {
      presets = (await readAgentPresets(ctx)).presets
      cache.set(PRESET_CACHE_KEY, { at: Date.now(), items: presets })
    }

    return presets
      .filter((preset) => preset.broken === undefined)
      .filter((preset) => typed.length === 0 || preset.id.toLowerCase().includes(typed) || (preset.name ?? '').toLowerCase().includes(typed))
      .slice(0, CHOICE_LIMIT)
      .map((preset) => ({ name: `${preset.name ?? preset.id} — ${preset.id}`.slice(0, 100), value: preset.id }))
  }

  /**
   * Permission choices for `/dsh permission`. The roster is an in-memory table,
   * so this needs no cache.
   * @param {string} typed - what the user has typed so far.
   * @returns {Promise<object[]>} Discord choice objects.
   */
  async function permissionChoices(typed) {
    const state = await readPermissionPresets(ctx)
    return state.options
      .filter((option) => typed.length === 0 || option.id.toLowerCase().includes(typed))
      .slice(0, CHOICE_LIMIT)
      .map((option) => ({
        name: `${option.name}${option.sandbox === undefined ? '' : ` — ${option.sandbox} · ${option.approval}`}`.slice(0, 100),
        value: option.id,
      }))
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
      // Three subcommands share the option name `to`, so the subcommand — not
      // the option — decides which catalog answers.
      if (focused.name === 'to') {
        const sub = interaction.options.getSubcommand(false)
        if (sub === 'preset') await interaction.respond(await presetChoices(typed))
        else if (sub === 'permission') await interaction.respond(await permissionChoices(typed))
        else await interaction.respond(await modelChoices(typed))
        return
      }

      if (focused.name === 'name') {
        const commands = await harnessCommands(await workspaceForChannel(interaction))
        await interaction.respond(commands
          .filter((command) => typed.length === 0 || command.name.toLowerCase().includes(typed))
          .slice(0, CHOICE_LIMIT)
          .map((command) => ({
            name: `/${command.name} — ${command.description ?? ''}`.slice(0, 100),
            value: command.name,
          })))
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
    const hasFiles = (message.attachments?.size ?? 0) > 0
    if (prompt.length === 0 && !hasFiles) return

    let status
    try {
      status = await message.reply({ content: t('run.reading') })
    } catch {
      return
    }

    // Files dropped into the channel become context for the prompt they came
    // with. Reading them is best-effort and reported: a file that was too big
    // or not text must not silently look like it was read.
    const { blocks, read, skipped } = hasFiles ? await readAttachments(message) : { blocks: [], read: [], skipped: [] }
    if (skipped.length > 0) {
      await message.react('⚠️').catch(() => {})
      logger.debug('dsh-discord-bot: skipped %d attachment(s): %s', skipped.length, skipped.join(', '))
    }

    try {
      await startRun({
        workspace,
        blocks,
        prompt: prompt.length === 0 ? t('run.attachedOnly', { files: read.join(', ') || '—' }) : prompt,
        t,
        channelId: message.channelId,
        post: async (payload) => { await status.edit({ content: null, ...payload }) },
      })
    } catch (error) {
      logger.warn('dsh-discord-bot: chat run failed: %s', described(error))
      await status.edit({ content: null, ...render.renderError(error, t) }).catch(() => {})
    }
  }

  /**
   * Handle one click on a `/dsh menu` card.
   *
   * The card is edited in place rather than replied to: it is one long-lived
   * message that someone keeps scrolling back to, and a new message per click
   * would bury it. Failures answer privately for the same reason — a card that
   * turned into an error would take the controls with it.
   *
   * @param {object} interaction - the component interaction.
   * @returns {Promise<void>} resolution once the card is rewritten.
   */
  async function handleMenu(interaction) {
    const t = translator(config.language, interaction.locale)

    if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
      await interaction.reply({ content: t('error.notAllowed'), flags: MessageFlags.Ephemeral })
      return
    }

    // Search and Sync are not card-state transitions: Search must open a modal
    // (which cannot happen after deferUpdate), and Sync answers privately so the
    // card itself is not buried under a status report.
    const { kind } = decodeMenu(interaction.customId)
    if (kind === 'search') {
      const modal = new ModalBuilder()
        .setCustomId('dsh:menu-search')
        .setTitle(t('modal.searchTitle'))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('query')
            .setLabel(t('modal.searchLabel'))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t('modal.searchPlaceholder'))
            .setMaxLength(200)
            .setRequired(true),
        ))
      await interaction.showModal(modal)
      return
    }

    if (kind === 'sync') {
      await interaction.deferUpdate()
      try {
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
        ].filter(Boolean)
        await interaction.followUp({ content: `🔄 ${parts.join(' · ')}`, flags: MessageFlags.Ephemeral })
      } catch (error) {
        logger.warn('dsh-discord-bot: menu sync failed: %s', described(error))
        await interaction.followUp({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
      }
      return
    }

    await interaction.deferUpdate()

    try {
      const workspace = await workspaceForChannel(interaction)
      const result = await applyMenu({ interaction, ctx, config, workspace, mapped: mappedCount(), t })
      // `attachments: []` drops whatever the previous view spilled to a file;
      // without it Discord keeps the old attachment alongside the new one.
      await interaction.editReply({ attachments: [], ...(result.closed === true ? closedMenu(t) : result) })
    } catch (error) {
      logger.warn('dsh-discord-bot: menu click failed: %s', described(error))
      await interaction.followUp({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
    }
  }

  /**
   * Handle a click on the rewind picker.
   *
   * The card carries the source session in its own id, so a picker left in
   * scrollback still knows what it was for. The session must still be live —
   * the events being sliced are the live log's, and a session that has since
   * been disposed can no longer supply them.
   *
   * @param {object} interaction - the component interaction.
   * @returns {Promise<void>} resolution once the card is answered.
   */
  async function handleRewind(interaction) {
    const t = translator(config.language, interaction.locale)

    if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
      await interaction.reply({ content: t('error.notAllowed'), flags: MessageFlags.Ephemeral })
      return
    }
    if (!config.allowRun) {
      await interaction.reply({ ...render.renderError(new TranslatableError('error.writeDisabled'), t), flags: MessageFlags.Ephemeral })
      return
    }

    await interaction.deferUpdate()

    try {
      const workspace = await workspaceForChannel(interaction)
      const short = interaction.customId.slice(`${render.REWIND_PREFIX}:`.length)
      const sessionId = await resolveSessionId(ctx, workspace, short)

      const agent = ctx.get('agents')?.get(sessionId)
      if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short })

      const result = await rewindSession({
        ctx,
        agent,
        seq: Number(interaction.values?.[0]),
        workspace,
        owned: ownedAgents,
        logger,
      })
      await interaction.editReply(render.renderRewound(result, t))
    } catch (error) {
      logger.warn('dsh-discord-bot: rewind failed: %s', described(error))
      await interaction.followUp({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
    }
  }

  /**
   * Handle one Discord interaction: a slash command, an autocomplete, or a
   * click on a menu card.
   * @param {object} interaction - the Discord interaction.
   * @returns {Promise<void>} resolution once the interaction is answered.
   */
  /**
   * Handle a click on a running turn's card.
   *
   * The card buttons are stateless — the session short id and the action live
   * in the component id, so a card left in scrollback still works after a
   * restart. Trace and subagents answer privately: the running card is the
   * thing the channel is watching, and burying it under a full trajectory
   * would defeat the one-message-per-turn shape. Stop edits the card to retire
   * its own button, then confirms privately.
   *
   * @param {object} interaction - the button interaction.
   * @returns {Promise<void>} resolution once the click is answered.
   */
  async function handleAction(interaction) {
    const t = translator(config.language, interaction.locale)

    if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
      await interaction.reply({ content: t('error.notAllowed'), flags: MessageFlags.Ephemeral })
      return
    }

    const { short, action } = decodeAction(interaction.customId)
    if (short === undefined || action === undefined) return

    // Steer opens a modal instead of editing the card, so it must not be
    // deferred first — `showModal` is the answer to the button interaction.
    if (action === 'steer') {
      if (!config.allowRun) {
        await interaction.reply({ ...render.renderError(new TranslatableError('error.writeDisabled'), t), flags: MessageFlags.Ephemeral })
        return
      }
      const modal = new ModalBuilder()
        .setCustomId(`dsh:steer:${short}`)
        .setTitle(t('modal.steerTitle'))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('prompt')
            .setLabel(t('modal.steerLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(t('modal.steerPlaceholder'))
            .setMaxLength(1800)
            .setRequired(true),
        ))
      await interaction.showModal(modal)
      return
    }

    await interaction.deferUpdate()

    try {
      const workspace = await workspaceForChannel(interaction)
      const sessionId = await resolveSessionId(ctx, workspace, short)
      const target = { id: sessionId, short, title: undefined }

      if (action === 'trace') {
        const [trajectory, stats] = await Promise.all([
          readTrajectory(ctx, sessionId, { limit: config.traceLimit }),
          readSessionStats(ctx, sessionId),
        ])
        await interaction.followUp({ ...render.renderTrajectory(target, trajectory, t, stats), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'timeline') {
        const [timeline, stats] = await Promise.all([
          readTimeline(ctx, sessionId, { limit: config.traceLimit }),
          readSessionStats(ctx, sessionId),
        ])
        await interaction.followUp({ ...render.renderTimeline(target, timeline, t, stats), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'subagents') {
        const entries = await listSubagents(ctx, sessionId, { deep: false })
        await interaction.followUp({ ...render.renderSubagents(target, entries, false, t), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'todos') {
        const todos = readTodos(ctx, sessionId)
        if (todos === undefined) throw new TranslatableError('error.sessionNotLive', { short })
        await interaction.followUp({ ...render.renderTodos(target, todos, t), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'export') {
        await interaction.followUp({ ...render.renderExport(target, await exportSession(ctx, sessionId), t), flags: MessageFlags.Ephemeral })
        return
      }

      // Two-step stop: the first click only arms a Confirm/Cancel row. A phone
      // in a pocket should not be able to interrupt work by accident.
      if (action === 'stop') {
        if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
        await interaction.editReply({ components: actionButtons(short, { allowRun: true, confirming: true, t }) }).catch(() => {})
        await interaction.followUp({ content: t('action.stopConfirmHint'), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'confirm') {
        if (!config.allowRun) throw new TranslatableError('error.writeDisabled')
        const stopped = cancelSession(ctx, sessionId)
        // The turn is over; retire the execution row but keep the read buttons.
        await interaction.editReply({ components: actionButtons(short, { allowRun: false, t }) }).catch(() => {})
        await interaction.followUp({ ...render.renderStopped(stopped, t), flags: MessageFlags.Ephemeral })
        return
      }

      if (action === 'cancel') {
        await interaction.editReply({ components: actionButtons(short, { allowRun: true, t }) }).catch(() => {})
        await interaction.followUp({ content: t('action.stopCancelled'), flags: MessageFlags.Ephemeral })
        return
      }

      throw new TranslatableError('error.unknownSubcommand', { sub: action })
    } catch (error) {
      logger.warn('dsh-discord-bot: action click failed: %s', described(error))
      await interaction.followUp({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
    }
  }

  /**
   * Handle a modal submit: a steer instruction from a running card, a search
   * query from the menu, or a free-text answer to a harness question.
   * @param {import('discord.js').ModalSubmitInteraction} interaction - the modal submit.
   * @returns {Promise<void>} resolution once the modal is answered.
   */
  async function handleModalSubmit(interaction) {
    const t = translator(config.language, interaction.locale)

    if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
      await interaction.reply({ content: t('error.notAllowed'), flags: MessageFlags.Ephemeral })
      return
    }

    const id = String(interaction.customId ?? '')

    if (id.startsWith('dsh:steer:')) {
      await handleSteerModal(interaction, t)
      return
    }

    if (id === 'dsh:menu-search') {
      await handleMenuSearchModal(interaction, t)
      return
    }

    if (id.startsWith(`${QUESTION_MODAL_PREFIX}:`)) {
      await answerQuestionModal(interaction, t)
      return
    }
  }

  /**
   * Deliver a steer message typed into a running card's modal.
   *
   * The custom id carries the session short id, the same stateless encoding the
   * buttons use. The channel the modal was opened from is still the workspace
   * channel, so the session resolves exactly as a button click would.
   *
   * @param {import('discord.js').ModalSubmitInteraction} interaction - the modal submit.
   * @param {(key: string, params?: object) => string} t - translator.
   * @returns {Promise<void>} resolution once the message is delivered.
   */
  async function handleSteerModal(interaction, t) {
    const short = String(interaction.customId ?? '').slice('dsh:steer:'.length)
    const prompt = interaction.fields.getTextInputValue('prompt').trim()
    if (prompt.length === 0) throw new TranslatableError('error.noPrompt')

    try {
      const workspace = await workspaceForChannel(interaction)
      const sessionId = await resolveSessionId(ctx, workspace, short)
      const agent = ctx.get('agents')?.get(sessionId)
      if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short })
      if (activity?.isRunning(sessionId) !== true) throw new TranslatableError('error.notRunning')

      agent.steer(userMessage(prompt))
      await interaction.reply({ ...render.renderSteered({ short, prompt }, t), flags: MessageFlags.Ephemeral })
    } catch (error) {
      logger.warn('dsh-discord-bot: steer modal failed: %s', described(error))
      await interaction.reply({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
    }
  }

  /**
   * Run a search typed into the menu card's search modal.
   *
   * The menu card lives in a workspace channel, so the modal submit resolves the
   * same workspace the card was opened in and answers privately — the card
   * itself is not buried under a result page.
   *
   * @param {import('discord.js').ModalSubmitInteraction} interaction - the modal submit.
   * @param {(key: string, params?: object) => string} t - translator.
   * @returns {Promise<void>} resolution once the search is answered.
   */
  async function handleMenuSearchModal(interaction, t) {
    const query = interaction.fields.getTextInputValue('query').trim()
    if (query.length === 0) throw new TranslatableError('error.searchEmpty')

    try {
      const workspace = await workspaceForChannel(interaction)
      const results = await searchWorkspaceSessions(ctx, workspace, query, { limit: 15 })
      await interaction.reply({ ...render.renderSearchResults(workspace, query, results, t), flags: MessageFlags.Ephemeral })
    } catch (error) {
      logger.warn('dsh-discord-bot: menu search failed: %s', described(error))
      await interaction.reply({ ...render.renderError(error, t), flags: MessageFlags.Ephemeral }).catch(() => {})
    }
  }

  /**
   * Handle one Discord interaction: a slash command, an autocomplete, or a
   * click on a menu card.
   * @param {object} interaction - the Discord interaction.
   * @returns {Promise<void>} resolution once the interaction is answered.
   */
  async function handleInteraction(interaction) {
    if (interaction.guildId !== config.guildId) return

    // Approval cards collect their own buttons on their own message, so only
    // this menu's components are claimed here.
    if (interaction.isStringSelectMenu?.() === true || interaction.isButton?.() === true) {
      if (isMenuInteraction(interaction)) await handleMenu(interaction)
      else if (String(interaction.customId ?? '').startsWith(`${render.REWIND_PREFIX}:`)) await handleRewind(interaction)
      else if (isActionInteraction(interaction)) await handleAction(interaction)
      return
    }

    if (interaction.isModalSubmit?.() === true) {
      await handleModalSubmit(interaction)
      return
    }

    if (interaction.isAutocomplete()) {
      try {
        await autocomplete(interaction)
      } catch (error) {
        logger.debug('autocomplete failed: %s', described(error))
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
      logger.warn('/dsh %s failed: %s', interaction.options.getSubcommand(false) ?? '?', described(error))
      await interaction.editReply(render.renderError(error, t)).catch(() => {})
    }
  }

  return { handleInteraction, handleMessage }
}
