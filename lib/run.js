import { randomUUID } from 'node:crypto'

import { TranslatableError, translator } from './i18n.js'
import { NARRATIVE_TYPES, shortId } from './queries.js'
import { rememberSelection } from './selection.js'
import { described } from './util.js'

/** Fallback translator for callers that pass none. */
const EN = translator('en')

/**
 * Driving an agent from Discord: deliver a prompt, follow the turn, and report
 * it back inside Discord's rate limits.
 *
 * This is the one place in the package that *causes* work on the machine
 * instead of describing it. Everything here is gated by the same allowlist as
 * the read commands, and the surface is deliberately one verb — deliver a
 * prompt to an existing session — rather than a general remote-control API.
 */

/** How often the in-progress message is rewritten while a turn runs. */
const UPDATE_INTERVAL_MS = 3000
/** Characters of live transcript kept in the status message. */
const LIVE_BUDGET = 1600
/** Per-entry clip inside the live transcript. */
const ENTRY_BUDGET = 220

/**
 * Build the message handed to `agent.followup()`.
 *
 * Equivalent to the harness's own `createUserMessage` — a frozen
 * `{role, content, source}` carrying a fresh uuid — reimplemented here so the
 * package keeps importing nothing from `@deepseek-ai/*`; see `config.js` for
 * why that matters. `source.kind: 'user'` is what the headless entry point
 * sends for a human prompt.
 *
 * Extra blocks follow the typed text rather than replacing it: the first block
 * is what the person said, and what every transcript renders, while attachment
 * contents are context the model reads behind it.
 *
 * @param {string} text - the prompt text.
 * @param {object[]} [extra] - further content blocks, appended in order.
 * @returns {object} an identified, frozen user message.
 */
export function userMessage(text, extra = []) {
  const blocks = [{ type: 'text', text }, ...extra].map((block) => Object.freeze({ ...block }))
  return Object.freeze({
    role: 'user',
    content: Object.freeze(blocks),
    source: Object.freeze({ kind: 'user' }),
    id: randomUUID(),
  })
}

/**
 * Extract the human-visible part of one session event, or `undefined` when the
 * event carries nothing worth showing. Reasoning is deliberately dropped: it is
 * long, it is not the answer, and Discord charges an edit for every character.
 * @param {object} event - a live session event.
 * @returns {{label: string, text: string} | undefined} a display entry.
 */
export function displayEntry(event) {
  // The vocabulary lives in one place (queries.js); anything outside the
  // narrative set is reasoning, structure, or plumbing and shows nothing.
  if (!NARRATIVE_TYPES.has(event.type)) return undefined
  const data = event.data ?? {}

  if (event.type === 'assistant/message') {
    const text = (data.message?.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return text.length === 0 ? undefined : { label: '🤖', text }
  }

  if (event.type === 'tool/call') {
    const args = typeof data.arguments === 'string' ? data.arguments : ''
    return { label: '🔧', text: `${data.name ?? 'tool'} ${args}`.trim() }
  }

  if (event.type === 'tool/result') {
    const text = (data.message?.content ?? [])
      .flatMap((part) => (part?.content ?? []))
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return text.length === 0 ? undefined : { label: '📄', text }
  }

  if (event.type === 'user/message') {
    // The user-role surface carries three things: a person's prompt, an
    // injected context (file-change notices, skill content, cron wake-ups) and
    // a goal continuation round. Only the first was typed by anyone, and
    // showing the other two would report the harness's own plumbing as
    // something a human said.
    if (data.source?.kind !== 'user') return undefined
    const text = (data.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return text.length === 0 ? undefined : { label: '👤', text }
  }

  return undefined
}

/**
 * Render one turn's accumulated entries into a message body.
 *
 * Shared by the two surfaces that watch a turn: `runTurn`, which drives one
 * from Discord, and the mirror, which only observes. Keeping one renderer means
 * a turn started in the web UI and a turn started here read identically once
 * they reach a channel.
 *
 * `minimal` answers the question the person asked: while it runs, one line
 * naming the tool in flight; when it finishes, the agent's closing words and
 * nothing else. `full` keeps the running transcript, which is useful when you
 * are watching *how* it works rather than waiting for what it concluded.
 *
 * @param {{label: string, text: string}[]} entries - display entries, in order.
 * @param {object} options - rendering options.
 * @param {'minimal' | 'full'} [options.verbosity] - how much of the turn to show.
 * @param {string} options.status - the heading line.
 * @param {boolean} options.done - whether the turn has finished.
 * @param {number} [options.toolCount] - tool calls this turn made, when the
 *   caller counted them itself. An observer that prunes its buffer knows a
 *   truer number than the entries it still holds; without one the entries are
 *   the count, which is right for a caller that keeps them all.
 * @param {(key: string, params?: object) => string} [options.t] - translator.
 * @returns {string} the message body.
 */
export function renderTurnBody(entries, { verbosity = 'minimal', status, done, toolCount, t = EN }) {
  if (verbosity === 'minimal') {
    const counted = toolCount ?? entries.filter((entry) => entry.label === '🔧').length

    if (!done) {
      const last = entries.filter((entry) => entry.label === '🔧').at(-1)
      const running = last === undefined ? t('run.thinking') : `🔧 \`${last.text.split(/\s/)[0]}\``
      return `${status}\n${running}${counted > 1 ? `  ·  ${t('run.toolCalls', { count: counted })}` : ''}`
    }

    const said = entries.filter((entry) => entry.label === '🤖').at(-1)
    const answer = said === undefined ? t('run.silent') : said.text.slice(0, 3000)
    return `${status}\n${answer}${counted === 0 ? '' : `\n\n${t('run.toolCount', { count: counted })}`}`
  }

  const lines = []
  let used = 0
  for (const entry of [...entries].reverse()) {
    const text = entry.text.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, ENTRY_BUDGET)
    const line = `${entry.label} ${text}`
    if (used + line.length > LIVE_BUDGET) break
    lines.unshift(line)
    used += line.length
  }
  const shown = lines.join('\n')
  return `${status}\n${shown.length === 0 ? t('run.working') : shown}`
}

/**
 * Bind a provider/model selection to one agent's prompt assembly and requests.
 *
 * Equivalent to the harness's own `installModelSelection`, reimplemented from
 * its two observable effects so this package keeps importing nothing from
 * `@deepseek-ai/*`: it is only a pair of waterfall listeners on `agentCtx`, and
 * `ctx.on` is contact surface this plugin already has.
 *
 * Without it, prompt assembly has no value for the `{{model}}` variable and the
 * very first turn dies with `prompt variable "{{model}}" has no value`. Every
 * entry point that creates or resumes an agent installs this; a caller that
 * skips it gets an agent that accepts work and then fails to think.
 *
 * @param {object} agentCtx - the agent's scope context, from `setup`.
 * @param {{current: object | undefined, assembled: object | undefined}} selection - mutable selection ref.
 * @returns {() => void} disposer removing both listeners.
 */
function installModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })

  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })

  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/**
 * The two things an agent needs that its session log does not carry: the model
 * selection (prompt variables and request routing) and the preset that supplies
 * its tools and prompt sections.
 *
 * Every path that mints an agent — create, resume, rewind — needs both. Skipping
 * the selection kills the first turn on `prompt variable "{{model}}" has no
 * value`; skipping the preset produces the more confusing failure, where the
 * model has no tool schemas and writes its tool calls as prose that nothing
 * executes.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} [options] - composition overrides.
 * @param {string} [options.presetId] - preset to mount instead of the default.
 * @param {object} [options.agentOptions] - model route to use instead of the default.
 * @returns {{setup: Function, agentOptions: object | undefined}} factory inputs.
 */
export function composeAgent(ctx, { presetId, agentOptions } = {}) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const presets = ctx.get('agentPresets')

  const setup = async (agentCtx) => {
    if (selection !== undefined) {
      // Retained rather than passed as a literal: `/dsh model` on a live
      // session moves this exact object. Left unretained, the only thing a
      // switch could reach was the deployment default — which an agent reads
      // once, at composition, and never again.
      const ref = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, ref)
      if (agentCtx.agent !== undefined) rememberSelection(agentCtx.agent, ref)
    }
    if (presets !== undefined) await presets.mount(agentCtx, presetId)
  }

  const route = agentOptions ?? (selection === undefined
    ? undefined
    : { provider: selection.provider, model: selection.model })

  return { setup, agentOptions: route }
}

/**
 * Reorder a workspace's sessions so the one mid-turn comes first.
 *
 * `resolveAgent` takes the first live session it finds, which is right when one
 * agent is live and wrong when two are: steering into the idle one would leave
 * the running turn untouched and queue the prompt behind a turn nobody is
 * waiting on. The status feed knows which is which.
 *
 * @param {object[]} sessions - the workspace's sessions, newest-first.
 * @param {object} [activity] - the live-status tracker.
 * @returns {object[]} the same sessions, with a running one at the front.
 */
export function preferRunning(sessions, activity) {
  const running = sessions.find((entry) => activity?.isRunning(entry.id) === true)
  if (running === undefined) return sessions
  return [running, ...sessions.filter((entry) => entry.id !== running.id)]
}

/**
 * The session in a workspace that a setting change should follow — without
 * starting one.
 *
 * Deliberately not `resolveAgent`: that one resumes the newest session, or
 * mints a fresh one, because a prompt has to land somewhere. A model switch has
 * somewhere to land already (the deployment default), so waking a cold session
 * just to retarget it would be work nobody asked for. A workspace whose
 * sessions are all cold simply has no conversation for the switch to follow.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object[]} sessions - the workspace's sessions, newest first.
 * @param {object} [activity] - the live-status tracker.
 * @returns {string | undefined} the session id to follow, when one is live.
 */
export function liveSessionFor(ctx, sessions, activity) {
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  return preferRunning(sessions, activity).find((entry) => agents.get(entry.id) !== undefined)?.id
}

/**
 * Find the agent that should receive a prompt for one workspace.
 *
 * A live agent is used as-is; otherwise the workspace's newest session is
 * resumed, and a workspace with none gets a fresh one.
 *
 * Bringing an agent back is only half the job in either case. The session log
 * restores the conversation, not the agent: the model selection and the preset
 * that supplies its tools and prompt sections must be installed by whoever
 * composes it. Skip them and the agent accepts work, then either dies on
 * `prompt variable "{{model}}" has no value` or — with no tool schemas — writes
 * its tool calls as prose that nothing executes.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object[]} sessions - the workspace's sessions, newest first.
 * @param {Map<string, object>} owned - handles this plugin created or resumed.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the target workspace.
 * @param {object} [logger] - plugin logger, for filing diagnostics.
 * @returns {Promise<object>} the agent to drive.
 */
export async function resolveAgent(ctx, sessions, owned, workspace, logger) {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new TranslatableError('error.serviceMissing', { service: 'agents' })

  const live = sessions.find((session) => agents.get(session.id) !== undefined)
  if (live !== undefined) return agents.get(live.id)

  const target = sessions[0]
  if (target !== undefined) {
    const existing = owned.get(target.id)
    if (existing !== undefined) return existing.agent
  }

  const { setup, agentOptions } = composeAgent(ctx)

  // A workspace with no session yet gets a fresh one rooted at its directory,
  // so `/dsh run` works the first time rather than sending someone to the GUI.
  const handle = target === undefined
    ? await agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: workspace.path },
        agentOptions,
        setup,
      })
    : await agents.resume({ resumeSessionId: target.id, agentOptions, setup })

  // Filed on both paths, not just creation: attaching an already-accounted id
  // writes nothing, so this also repairs a session that ended up unfiled —
  // right cwd, absent from the account, showing as "Ungrouped" in dsh.
  const sessionId = String(handle.agent.session.id)
  await attachToWorkspace(ctx, workspace, sessionId, logger)

  owned.set(sessionId, handle)
  return handle.agent
}

/**
 * Record a newly created session on its workspace's account.
 *
 * Workspace membership in dsh is an explicit durable account, not something
 * inferred from the session's cwd — a matching cwd is *necessary* but the id
 * still has to be attached. Every GUI entry point does this at creation; a
 * session created without it has the right cwd and still shows up under
 * "Ungrouped", which is exactly as wrong as it looks.
 *
 * Failure is not fatal: the session exists and works, it is merely unfiled, so
 * a rejected attach must not take the run down with it.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the owning workspace.
 * @param {string} sessionId - the session just created.
 * @returns {Promise<void>} resolution once the attach settles.
 */
async function attachToWorkspace(ctx, workspace, sessionId, logger) {
  // A synthesized workspace has no registry record to attach to; grouping there
  // is derived from cwd in the first place.
  if (workspace.synthetic) return

  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return

  const record = registry.get(workspace.id)
  if (record === undefined) {
    logger?.warn('dsh-discord-bot: workspace %s vanished from the registry; session %s stays ungrouped', workspace.id, sessionId)
    return
  }

  try {
    await record.attachSession(sessionId)
  } catch (error) {
    // Unfiled but usable — say so, because "Ungrouped" in the dsh sidebar is
    // otherwise an unexplained symptom with no visible cause.
    logger?.warn('dsh-discord-bot: could not file session %s under "%s": %s', sessionId, workspace.title, described(error))
  }
}

/**
 * The points a session can be rewound to: the prompts a person actually typed.
 *
 * Injected context and goal continuations share the user role and are not
 * places anyone means by "go back to where I asked for X", so they are left out
 * for the same reason `displayEntry` drops them.
 *
 * @param {object} agent - the live agent whose log to read.
 * @returns {object[]} owned `{seq, text}` points, oldest first.
 */
export function rewindPoints(agent) {
  const points = []
  for (const event of agent.session.events) {
    if (event.type !== 'user/message') continue
    const entry = displayEntry(event)
    if (entry === undefined) continue
    points.push({ seq: event.seq, text: entry.text })
  }
  return points
}

/**
 * The fork boundary for one rewind point: the last event before the turn that
 * claimed that message.
 *
 * A user message's own seq sits *inside* its turn, so forking there would keep
 * an open turn in the seed and the create boundary would refuse it. Walking
 * back to the turn's `turn/start` and stopping one event short gives a seed
 * that ends on a completed turn — which is exactly what the harness validates.
 *
 * @param {object} agent - the live agent.
 * @param {number} seq - the chosen user message's sequence number.
 * @returns {number} the inclusive boundary, or -1 when there is nothing before it.
 */
export function rewindBoundary(agent, seq) {
  const events = agent.session.events
  for (let i = seq; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined) break
    if (event.type === 'turn/start') return event.seq - 1
    // A closed turn before reaching a start means the message was not claimed
    // by a turn at all; there is no boundary to derive.
    if (event.type === 'turn/end') break
  }
  return -1
}

/**
 * Rewind a session: continue it as a new one that stops just before a chosen
 * prompt, leaving the original untouched.
 *
 * The seed is sliced here rather than taken from `sessions.fork()`. `fork` is
 * the natural-looking call and it *creates a live child session in the store* —
 * one this bot would then abandon, because `agents.create` must own the session
 * it drives and cannot adopt a pre-created one. Slicing the events costs one
 * array operation and leaks nothing.
 *
 * The new session continues under the source's own preset and model route: a
 * rewind resumes a conversation, so the composition it was produced under is
 * the correct one, not whatever the deployment default has since become.
 *
 * @param {object} args - rewind inputs.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.agent - the live agent to rewind.
 * @param {number} args.seq - the chosen user message's sequence number.
 * @param {import('./workspaces.js').WorkspaceView} args.workspace - the owning workspace.
 * @param {Map<string, object>} args.owned - handles this plugin owns.
 * @param {object} [args.logger] - plugin logger.
 * @returns {Promise<object>} the new session's identity and what was dropped.
 */
export async function rewindSession({ ctx, agent, seq, workspace, owned, logger }) {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new TranslatableError('error.serviceMissing', { service: 'agents' })

  if (agent.status === 'running') throw new TranslatableError('error.rewindRunning')

  const events = agent.session.events
  // Both the boundary walk and the slice below address events by position,
  // which is only the same as their sequence number for a log that starts at
  // zero. The create boundary would reject a misaligned seed anyway; refusing
  // here means the reader gets this sentence instead of a harness stack trace.
  if (events.length > 0 && events[0]?.seq !== 0) throw new TranslatableError('error.cannotRewind')

  const boundary = rewindBoundary(agent, seq)
  if (boundary < 0) throw new TranslatableError('error.cannotRewind')

  const seed = events.slice(0, boundary + 1)
  const sourceId = String(agent.session.id)

  const preset = agent.session.header?.agentPreset
  const { setup, agentOptions } = composeAgent(ctx, {
    presetId: preset,
    agentOptions: agent.options === undefined
      ? undefined
      : { provider: agent.options.provider, model: agent.options.model },
  })

  const handle = await agents.create({
    sessionId: `session-${randomUUID()}`,
    seed,
    meta: {
      cwd: workspace.path,
      parentSession: agent.session.id,
      seedLength: seed.length,
      ...(preset === undefined ? {} : { agentPreset: preset }),
    },
    agentOptions,
    setup,
  })

  const sessionId = String(handle.agent.session.id)
  await attachToWorkspace(ctx, workspace, sessionId, logger)
  owned.set(sessionId, handle)

  return {
    id: sessionId,
    short: shortId(sessionId),
    from: shortId(sourceId),
    kept: seed.length,
    dropped: events.length - seed.length,
  }
}

/**
 * Deliver a prompt and stream the resulting turn back into one Discord reply.
 *
 * Discord allows roughly five messages per five seconds per channel, and a busy
 * turn emits hundreds of events, so the turn is reported by rewriting a single
 * message on a timer rather than by posting as things happen.
 *
 * @param {object} args - run inputs.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.agent - the agent to drive.
 * @param {string} args.prompt - the user's prompt.
 * @param {object[]} [args.blocks] - extra content blocks (attachment contents).
 * @param {(body: string, options?: {done?: boolean}) => Promise<void>} args.report - rewrite the status message.
 * @param {object} args.logger - the plugin logger.
 * @param {'minimal' | 'full'} [args.verbosity] - how much of the turn to show.
 * @returns {Promise<string>} the final rendered body.
 */
export async function runTurn({ ctx, agent, prompt, blocks = [], report, logger, verbosity = 'minimal', t = EN }) {
  const sessionId = String(agent.session.id)
  /** @type {{label: string, text: string}[]} */
  const entries = []
  let dirty = true

  const stop = ctx.on('session/event', (session, event) => {
    if (String(session.id) !== sessionId) return
    const entry = displayEntry(event)
    if (entry === undefined) return
    entries.push(entry)
    dirty = true
  })

  /**
   * Render the turn as it stands.
   * @param {string} status - the heading line.
   * @param {boolean} done - whether the turn has finished.
   * @returns {string} the message body.
   */
  const body = (status, done) => renderTurnBody(entries, { verbosity, status, done, t })

  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    report(body(t('run.running'), false)).catch(() => {})
  }, UPDATE_INTERVAL_MS)

  try {
    agent.followup(userMessage(prompt, blocks))
    await agent.whenIdle()
  } finally {
    clearInterval(timer)
    stop()
  }

  const final = body(t('run.done'), true)
  // The closing frame is flagged so a caller can retire whatever only applied
  // while the turn was live — the steer and stop buttons on its card.
  await report(final, { done: true }).catch((error) => {
    logger.warn('dsh-discord-bot: could not post the final turn: %s', described(error))
  })
  return final
}
