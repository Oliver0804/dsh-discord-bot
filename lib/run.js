import { randomUUID } from 'node:crypto'

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
 * @param {string} text - the prompt text.
 * @returns {object} an identified, frozen user message.
 */
export function userMessage(text) {
  return Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
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

  return undefined
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
  if (agents === undefined) throw new Error('the `agents` service is not mounted in this dsh profile')

  const live = sessions.find((session) => agents.get(session.id) !== undefined)
  if (live !== undefined) return agents.get(live.id)

  const target = sessions[0]
  if (target !== undefined) {
    const existing = owned.get(target.id)
    if (existing !== undefined) return existing.agent
  }

  // Composing an agent takes two things the session log does not carry: the
  // model selection (prompt variables and request routing) and the preset that
  // supplies its tools and prompt sections. Both create and resume need them.
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const presets = ctx.get('agentPresets')

  const setup = async (agentCtx) => {
    if (selection !== undefined) {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }
    if (presets !== undefined) await presets.mount(agentCtx)
  }

  const agentOptions = selection === undefined
    ? undefined
    : { provider: selection.provider, model: selection.model }

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
    logger?.warn('dsh-discord-bot: could not file session %s under "%s": %s', sessionId, workspace.title, error instanceof Error ? error.message : error)
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
 * @param {(body: string) => Promise<void>} args.report - rewrite the status message.
 * @param {object} args.logger - the plugin logger.
 * @param {'minimal' | 'full'} [args.verbosity] - how much of the turn to show.
 * @returns {Promise<string>} the final rendered body.
 */
export async function runTurn({ ctx, agent, prompt, report, logger, verbosity = 'minimal' }) {
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
   * Render the turn.
   *
   * `minimal` answers the question the person asked: while it runs, one line
   * naming the tool in flight; when it finishes, the agent's closing words and
   * nothing else. `full` keeps the running transcript, which is useful when you
   * are watching *how* it works rather than waiting for what it concluded.
   *
   * @param {string} status - the heading line.
   * @param {boolean} done - whether the turn has finished.
   * @returns {string} the message body.
   */
  const body = (status, done) => {
    if (verbosity === 'minimal') {
      if (!done) {
        const tools = entries.filter((entry) => entry.label === '🔧')
        const last = tools.at(-1)
        const running = last === undefined ? '_thinking…_' : `🔧 \`${last.text.split(/\s/)[0]}\``
        return `${status}\n${running}${tools.length > 1 ? `  ·  ${tools.length} tool calls` : ''}`
      }

      const said = entries.filter((entry) => entry.label === '🤖').at(-1)
      const tools = entries.filter((entry) => entry.label === '🔧').length
      const answer = said === undefined ? '_the agent finished without saying anything_' : said.text.slice(0, 3000)
      return `${status}\n${answer}${tools === 0 ? '' : `\n\n_${tools} tool call(s)_`}`
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
    return `${status}\n${shown.length === 0 ? '_working…_' : shown}`
  }

  const timer = setInterval(() => {
    if (!dirty) return
    dirty = false
    report(body('⚙️ **running**', false)).catch(() => {})
  }, UPDATE_INTERVAL_MS)

  try {
    agent.followup(userMessage(prompt))
    await agent.whenIdle()
  } finally {
    clearInterval(timer)
    stop()
  }

  const final = body('✅ **done**', true)
  await report(final).catch((error) => {
    logger.warn('dsh-discord-bot: could not post the final turn: %s', error instanceof Error ? error.message : error)
  })
  return final
}
