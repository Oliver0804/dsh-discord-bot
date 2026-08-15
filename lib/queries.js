/**
 * Every read this bot performs against the harness, in one place.
 *
 * Two rules hold throughout. First, harness objects are internal live data: a
 * query returns plain owned JSON built from scalar leaves, never a borrowed
 * record, header, or event. Second, the writes live here too and are countable:
 * `switchModel`, `switchAgentPreset`, `switchPermissionPreset` and
 * `createWorkspace` are the whole set, each one a deployment setting a person
 * asked to change — never session content. Anything that causes an agent to
 * *work* lives in `run.js` behind `allowRun`, not in this file.
 */

import { TranslatableError } from './i18n.js'
import { assembleContextFor, serviceForAgent } from './scope.js'

/**
 * Session-event types that make up a readable trajectory.
 *
 * This is the vocabulary the whole package agrees on: the same type names are
 * what `run.js` picks out for its live view and what `render.js` labels in a
 * trace. Kept here so one place owns the set.
 */
export const NARRATIVE_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

/**
 * Translation key per session-event type, for trajectory lines. Lives beside
 * {@link NARRATIVE_TYPES} so the display vocabulary cannot drift from the
 * membership vocabulary.
 */
export const TYPE_LABEL = {
  'user/message': 'trace.label.user',
  'assistant/message': 'trace.label.assistant',
  'tool/call': 'trace.label.tool',
  'tool/result': 'trace.label.result',
}

/**
 * Require a mounted service, naming the missing one for the operator. A
 * profile that does not compose session-query cannot answer these commands,
 * and saying so beats an undefined-property stack trace in Discord.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} name - the service key to resolve.
 * @returns {object} the mounted service.
 */
function requiredService(ctx, name) {
  const service = ctx.get(name)
  if (service === undefined) throw new TranslatableError('error.serviceMissing', { service: name })
  return service
}

/** @param {string} id - a full session id. @returns {string} its short form. */
export function shortId(id) {
  return id.replace(/^session-/, '').slice(0, 8)
}

/**
 * List the sessions belonging to one workspace, newest-first.
 *
 * Membership is the union of the workspace's own account and any session whose
 * header cwd equals its path: the registry's account can lag behind a session
 * started outside the GUI, and a session the user can see in dsh but not in
 * Discord would read as data loss.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {import('./workspaces.js').WorkspaceView} workspace - target workspace.
 * @param {number} limit - maximum sessions to return.
 * @param {object} [options] - listing options.
 * @param {boolean} [options.titles] - fold each session's title (see below).
 * @returns {Promise<object[]>} owned session summaries.
 */
export async function listWorkspaceSessions(ctx, workspace, limit, { titles: wantTitles = true } = {}) {
  const sessionQuery = requiredService(ctx, 'sessionQuery')
  const records = await sessionQuery.listSessions()

  const accounted = new Set(workspace.sessionIds)
  const members = records.filter((record) => {
    const id = String(record.header.id)
    return accounted.has(id) || record.header.cwd === workspace.path
  })

  const page = members.slice(0, limit)
  const ids = page.map((record) => record.header.id)

  // Titles are the expensive half: `listSessions` is metadata-only, but folding
  // a title opens each cold session's log. Callers on a deadline — autocomplete
  // has three seconds and cannot defer — ask for the listing without them.
  const titles = wantTitles ? await readTitles(sessionQuery, ids) : new Map()

  return page.map((record) => ({
    id: String(record.header.id),
    short: shortId(String(record.header.id)),
    title: titles.get(String(record.header.id)),
    live: record.live === true,
    persisted: record.persisted === true,
    createdAt: record.header.createdAt,
    hasParent: record.header.parentSession !== undefined,
    accounted: accounted.has(String(record.header.id)),
    total: members.length,
  }))
}

/**
 * Search one workspace's sessions by full text.
 *
 * This is the harness's own search — `sessionQuery.searchSessions` against the
 * live-preferred logical corpus, narrowed to the workspace's cwd. Results are
 * already ranked by the strongest matching event, so the reply keeps that
 * order rather than re-sorting by age: a person searching from a phone wants
 * the relevant session, not the newest one.
 *
 * The result object is deliberately the same shape a session listing uses
 * (id/short/live/createdAt) plus the best-matching event, so a renderer can
 * show "hit → open with /dsh trace <short>" without a second read.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the channel's workspace.
 * @param {string} query - the full-text query, interpreted as data by the backend.
 * @param {object} [options] - search options.
 * @param {number} [options.limit] - maximum sessions to return.
 * @returns {Promise<{total: number, hits: object[]}>} ranked hits plus the
 *   session count that matched the query.
 */
export async function searchWorkspaceSessions(ctx, workspace, query, { limit = 15 } = {}) {
  const trimmed = String(query ?? '').trim()
  if (trimmed.length === 0) throw new TranslatableError('error.searchEmpty')

  const sessionQuery = requiredService(ctx, 'sessionQuery')
  if (typeof sessionQuery.searchSessions !== 'function') {
    throw new TranslatableError('error.searchUnavailable')
  }

  const page = await sessionQuery.searchSessions({
    query: trimmed,
    sessionFilters: [{ kind: 'cwd', values: [workspace.path] }],
    limit,
  })

  const hits = (page.items ?? []).map((hit) => ({
    id: String(hit.header.id),
    short: shortId(String(hit.header.id)),
    live: hit.live === true,
    createdAt: hit.header.createdAt,
    seq: hit.bestMatch?.seq,
    type: hit.bestMatch?.type,
    time: hit.bestMatch?.time,
    snippet: hit.bestMatch?.snippet,
  }))

  return { total: hits.length, hits }
}

/**
 * Fold the latest title for each id. One rejected session must not discard its
 * peers, so a failed observation simply yields no title.
 * @param {object} sessionQuery - `ctx.sessionQuery`.
 * @param {readonly unknown[]} ids - session ids to observe.
 * @returns {Promise<Map<string, string | undefined>>} id to title.
 */
async function readTitles(sessionQuery, ids) {
  /** @type {Map<string, string | undefined>} */
  const byId = new Map()
  if (ids.length === 0) return byId

  const results = await sessionQuery.readTitleSnapshots(ids)
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    byId.set(String(result.sessionId), result.value.title?.title)
  }
  return byId
}

/**
 * Read a session's trajectory as extracted semantic text.
 *
 * `filterEvents` runs the harness's own first-party document projection, which
 * already drops reasoning blocks, stream chunks, structural boundaries, and
 * request headers — the four categories that make a raw log unreadable and
 * that a hand-rolled filter here would get subtly wrong.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to read.
 * @param {object} options - read options.
 * @param {number} options.limit - maximum entries, taken from the tail.
 * @param {boolean} [options.everything] - keep non-narrative document types too.
 * @returns {Promise<{entries: object[], total: number}>} tail entries, oldest-first.
 */
export async function readTrajectory(ctx, sessionId, { limit, everything = false }) {
  const sessionQuery = requiredService(ctx, 'sessionQuery')
  const documents = await sessionQuery.filterEvents(sessionId, [])

  const relevant = everything ? documents : documents.filter((doc) => NARRATIVE_TYPES.has(doc.type))
  const tail = relevant.slice(Math.max(0, relevant.length - limit))

  return {
    total: relevant.length,
    entries: tail.map((doc) => ({
      seq: doc.seq,
      type: doc.type,
      time: doc.time,
      surface: doc.surface,
      text: doc.text,
    })),
  }
}

/**
 * Read a session's raw event timeline: metadata only, every event type
 * included. This is the structural view — turns, steps, chunks and all — for
 * when the question is "what did the harness do", not "what was said".
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to read.
 * @param {object} options - read options.
 * @param {number} options.limit - maximum entries, taken from the tail.
 * @returns {Promise<{entries: object[], total: number, counts: [string, number][]}>} timeline tail.
 */
export async function readTimeline(ctx, sessionId, { limit }) {
  const sessionQuery = requiredService(ctx, 'sessionQuery')
  const records = await sessionQuery.listEvents(sessionId)

  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1)

  const tail = records.slice(Math.max(0, records.length - limit))
  return {
    total: records.length,
    counts: [...counts].sort((a, b) => b[1] - a[1]),
    entries: tail.map((record) => ({
      seq: record.seq,
      type: record.type,
      time: record.time,
      surface: record.surface,
    })),
  }
}

/**
 * Enumerate a session's subagents. Direct children come from the registry's
 * `listChildren`; `deep` walks the whole descendant tree with root-relative
 * depth. Neither loads or resumes an agent.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the parent (or root) session.
 * @param {object} options - listing options.
 * @param {boolean} [options.deep] - walk the full descendant tree.
 * @returns {Promise<object[]>} owned subagent entries.
 */
export async function listSubagents(ctx, sessionId, { deep = false }) {
  const subagents = requiredService(ctx, 'subagents')
  const entries = deep
    ? await subagents.listDescendants(sessionId)
    : await subagents.listChildren(sessionId)

  return entries.map((entry) => (entry.kind === 'child'
    ? {
        kind: 'child',
        id: String(entry.id),
        short: shortId(String(entry.id)),
        activity: entry.activity,
        mode: entry.mode,
        label: entry.label,
        hasChildren: entry.hasChildren,
        depth: entry.depth,
        parentId: entry.parentId === undefined ? undefined : String(entry.parentId),
      }
    : {
        kind: 'diagnostic',
        id: String(entry.id),
        short: shortId(String(entry.id)),
        reason: entry.reason,
        depth: entry.depth,
      }))
}

/**
 * Trace one session's lineage: known ancestors outward from the immediate
 * parent, plus the complete known descendant trees.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to trace.
 * @returns {Promise<object>} owned lineage summary.
 */
export async function readLineage(ctx, sessionId) {
  const sessionQuery = requiredService(ctx, 'sessionQuery')
  const trace = await sessionQuery.traceSession(sessionId)

  const flatten = (nodes, depth = 1) => nodes.flatMap((node) => [
    { id: String(node.session.header.id), short: shortId(String(node.session.header.id)), live: node.session.live, depth },
    ...flatten(node.descendants, depth + 1),
  ])

  return {
    target: { id: String(trace.target.header.id), short: shortId(String(trace.target.header.id)), live: trace.target.live },
    ancestors: trace.ancestors.map((record) => ({
      id: String(record.header.id),
      short: shortId(String(record.header.id)),
      live: record.live,
    })),
    descendants: flatten(trace.descendants),
    complete: trace.complete === true,
    unresolvedParentId: trace.complete === true ? undefined : String(trace.unresolvedParentId),
  }
}

/**
 * A whole-harness snapshot for `/dsh status`: what is mounted, how many
 * sessions exist, and how many are live right now.
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {Promise<object>} owned overview.
 */
export async function readOverview(ctx) {
  const sessionQuery = ctx.get('sessionQuery')
  const records = sessionQuery === undefined ? [] : await sessionQuery.listSessions()

  return {
    services: {
      sessionQuery: sessionQuery !== undefined,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      subagents: ctx.get('subagents') !== undefined,
      sessionPersistence: ctx.get('sessionPersistence') !== undefined,
    },
    sessions: {
      total: records.length,
      live: records.filter((record) => record.live === true).length,
    },
  }
}

/**
 * Read one session's whole-log statistics.
 *
 * These are dsh's own folded figures — the same `sessionStats` and `tokenUsage`
 * projection units the web chat's stats strip renders — not numbers this plugin
 * derives. Paging and compaction cannot change them, which is exactly why they
 * belong in a footer that outlives the page it is attached to.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to measure.
 * @returns {Promise<object | undefined>} owned figures, or undefined when the
 *   projection seam is not composed in this profile.
 */
export async function readSessionStats(ctx, sessionId) {
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return undefined

  let values
  try {
    values = (await cache.coldSnapshot(sessionId))?.values
  } catch {
    return undefined
  }
  if (values === undefined) return undefined

  const stats = values.sessionStats
  // The projected value *is* the totals. The persisted checkpoint row wraps
  // them in `{totals, last}`, but that is the unit's internal state, not the
  // value it serves — reading the stored shape here yielded zeros for every
  // token figure while the times came through fine. Both are accepted so a
  // future shape change degrades rather than silently reporting nothing.
  const usage = values.tokenUsage?.totals ?? values.tokenUsage
  if (stats === undefined && usage === undefined) return undefined

  // The three prompt-side billing buckets, all of them. They are disjoint, so
  // the billed input is their sum and the hit rate is read over that same sum —
  // the way the web chat's stats strip folds it. Leaving the write bucket out
  // of the denominator inflates the rate and under-reports the input by exactly
  // what was written to the cache, which is most of a short session's prompt.
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  const uncached = usage?.uncachedInputTokens ?? 0
  const billedInput = cacheRead + cacheWrite + uncached

  return {
    turns: stats?.turns ?? 0,
    steps: stats?.steps ?? 0,
    llmMs: stats?.llmMs ?? 0,
    toolMs: stats?.toolMs ?? 0,
    // An average, not a sum: dsh counts the steps that contributed a first
    // token separately, because not every step produces one.
    ttftMs: stats?.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : 0,
    tokensPerSecond: stats?.decodeMs > 0 ? (stats.decodeTokens / stats.decodeMs) * 1000 : 0,
    cacheHit: billedInput > 0 ? cacheRead / billedInput : 0,
    inputTokens: billedInput,
    outputTokens: usage?.outputTokens ?? 0,
    // The buckets unfolded, because a rate and a sum cannot be taken apart
    // again and the two tiers are priced thirty-fold apart.
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: uncached,
    model: modelSelection(ctx, sessionId),
  }
}

/**
 * Which model a session's tokens should be priced against.
 *
 * A live agent knows what it is running; a session that has gone cold does not,
 * because no projection unit records the model and the log is not read here.
 * The default selection is the honest guess for that case — it is what the
 * session most likely ran on, and it is what a new one will run on — but it is
 * a guess, which is one more reason the price it feeds is rendered as a range
 * rather than a figure.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session being measured.
 * @returns {{provider: string | undefined, model: string | undefined}} the
 *   selection to price against; unknown fields simply yield no estimate.
 */
function modelSelection(ctx, sessionId) {
  const fallback = ctx.get('agentDefaultModel')?.currentSelection()
  const options = ctx.get('agents')?.get(sessionId)?.options

  return {
    provider: options?.provider ?? fallback?.provider,
    model: options?.model ?? fallback?.model,
  }
}

/**
 * Read the default model for newly created agents, plus what else is on offer.
 *
 * This is the deployment-wide default, not a per-session setting: dsh keeps
 * per-session selection with the entry point that created the session.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {Promise<object>} owned selection and catalog.
 */
export async function readModelSelection(ctx) {
  const defaults = requiredService(ctx, 'agentDefaultModel')
  const current = defaults.currentSelection()
  const llm = ctx.get('llm')

  const providers = llm === undefined ? [] : llm.listProviders().map((info) => ({ id: info.id, name: info.name }))

  // A provider route may serve models it does not advertise, so a failed or
  // empty catalog is informational — never a reason to block a switch.
  let models = []
  if (llm !== undefined) {
    try {
      models = (await llm.listModels(current.provider)).map((info) => ({
        id: info.id,
        name: info.name,
        description: info.description,
      }))
    } catch {
      models = []
    }
  }

  return {
    current: { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort },
    providers,
    models,
  }
}

/**
 * Switch the default model for newly created agents.
 *
 * `saveSelection()` is a silent no-op when no settings provider is mounted, so
 * the write is read back and compared. Reporting success for a save that did
 * not persist is the one failure mode that would actively mislead — the user
 * would believe every later session runs on a model it does not.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} spec - `model` or `provider/model`.
 * @returns {Promise<object>} the before and after selections.
 */
export async function switchModel(ctx, spec) {
  const defaults = requiredService(ctx, 'agentDefaultModel')
  const before = defaults.currentSelection()

  const wanted = spec.trim()
  if (wanted.length === 0) throw new TranslatableError('error.noModel')

  const slash = wanted.indexOf('/')
  const provider = slash === -1 ? before.provider : wanted.slice(0, slash)
  const model = slash === -1 ? wanted : wanted.slice(slash + 1)
  if (model.length === 0) throw new TranslatableError('error.providerOnly', { spec: wanted })

  // Deliberately no reasoningEffort: a saved selection is complete, and
  // carrying an old effort onto a model that does not support it would reject.
  await defaults.saveSelection({ provider, model })

  const after = defaults.currentSelection()
  if (after.provider !== provider || after.model !== model) {
    throw new TranslatableError('error.modelNotSaved')
  }

  return {
    before: { provider: before.provider, model: before.model },
    after: { provider: after.provider, model: after.model },
  }
}

/**
 * List the harness's own slash commands for one agent.
 *
 * `dsh-commands` is where the harness and its plugins publish human commands —
 * `/compact`, `/plan`, `/goal` and whatever else a deployment composes. Reading
 * the registry rather than hard-coding a list means this bot gains a command
 * the moment someone installs the plugin that registers it, and cannot claim
 * one that a particular profile does not have.
 *
 * Registrations may be global or scoped to one agent, which is why the listing
 * takes the agent rather than the context.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} agent - the agent whose effective commands to list.
 * @returns {object[]} owned descriptors; empty when the registry is absent.
 */
export function listHarnessCommands(ctx, agent) {
  const commands = ctx.get('commands')
  if (commands === undefined || agent === undefined) return []

  try {
    return commands.list(agent).map((descriptor) => ({
      name: String(descriptor.name),
      description: descriptor.description,
      hint: descriptor.input?.hint,
    }))
  } catch {
    // A registry that refuses the listing costs suggestions, not the command.
    return []
  }
}

/**
 * Run one harness command against an agent.
 *
 * The registry's own executor is used rather than a reimplementation: it mints
 * the pairing id, writes the `command/run` and `command/done` records into the
 * session log, and resolves the handler through the agent's scope — which is
 * how `/compact` reaches the compaction service inside its preset realm, a
 * service this bot cannot see from the root context at all.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} agent - the agent receiving the command.
 * @param {string} name - the command name, without the slash.
 * @param {string} [input] - free-form input following the name.
 * @param {AbortSignal} [signal] - cancellation for the dispatching request.
 * @returns {Promise<object>} the command's name and normalized outcome.
 */
export async function runHarnessCommand(ctx, agent, name, input, signal) {
  const commands = requiredService(ctx, 'commands')

  const wanted = String(name ?? '').trim().replace(/^\//, '')
  if (wanted.length === 0) throw new TranslatableError('error.noCommand')

  const trailing = String(input ?? '').trim()
  const line = trailing.length === 0 ? `/${wanted}` : `/${wanted} ${trailing}`

  const execution = await commands.execute(agent, line, signal ?? new AbortController().signal)
  // `undefined` means the line did not resolve — bad syntax, or a name this
  // deployment does not register. Saying which is better than an empty reply.
  if (execution === undefined) throw new TranslatableError('error.noSuchCommand', { name: wanted })

  return {
    name: wanted,
    ok: execution.result.kind === 'success',
    text: execution.result.text,
  }
}

/**
 * Read one live session's todo list.
 *
 * `todo/write` is a whole-list snapshot in the durable log, so the last one
 * wins. Only a live session can answer: the metadata listing carries no event
 * payloads, and the narrative projection deliberately drops log-only UI state.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to read.
 * @returns {object[] | undefined} the todos, or undefined when the session is
 *   not live and its list therefore cannot be read.
 */
export function readTodos(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) return undefined

  let todos = []
  for (const event of agent.session.events) {
    if (event.type !== 'todo/write') continue
    todos = Array.isArray(event.data?.todos) ? event.data.todos : []
  }

  return todos.map((todo) => ({ content: String(todo.content ?? ''), status: todo.status }))
}

/**
 * Read what one live agent's model actually sees: prompt sections, the tool
 * catalog, and the skills its composition supplies.
 *
 * Both halves must be read through the agent rather than the root context.
 * Prompt assembly needs `scope` set to the agent or the agent-scoped sections
 * and tools are silently missing, and the skill registry — host-plane but
 * layered per scope — answers a preset's own rows only for the agent that
 * composed them. Reading either from the root would report a catalog no
 * session is actually running with.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the live session to describe.
 * @returns {Promise<object>} owned section names, tools and skills.
 */
export async function readAgentContext(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short: shortId(sessionId) })

  const sections = []
  const tools = []
  const skills = []

  const systemPrompt = serviceForAgent(ctx, agent, 'systemPrompt')
  if (systemPrompt !== undefined) {
    const assembly = await systemPrompt.assemble(assembleContextFor(agent))
    for (const section of assembly.sections ?? []) sections.push(String(section.name))
    for (const tool of assembly.tools ?? []) {
      tools.push({ name: String(tool.name), description: tool.description })
    }
  }

  const registry = serviceForAgent(ctx, agent, 'skills')
  if (registry !== undefined) {
    // A failed catalog costs the skills column, not the whole answer.
    try {
      for (const skill of await registry.list({})) {
        skills.push({ name: String(skill.name), description: skill.description })
      }
    } catch {
      // reported as an empty list
    }
  }

  return { short: shortId(sessionId), sections, tools, skills }
}

/**
 * Render one session's whole trajectory as Markdown, for export.
 *
 * The same first-party projection `/dsh trace` reads, unclipped: an export
 * exists precisely because the message-sized view had to drop things.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to export.
 * @returns {Promise<{markdown: string, entries: number}>} the document.
 */
export async function exportSession(ctx, sessionId) {
  const { entries, total } = await readTrajectory(ctx, sessionId, { limit: Number.MAX_SAFE_INTEGER, everything: true })

  const lines = [`# session ${shortId(sessionId)}`, '', `_${total} entries · ${sessionId}_`, '']
  for (const entry of entries) {
    const stamp = Number.isFinite(entry.time) ? new Date(entry.time).toISOString() : ''
    lines.push(`## ${entry.type} · #${entry.seq}${stamp === '' ? '' : ` · ${stamp}`}`, '', entry.text ?? '', '')
  }

  return { markdown: lines.join('\n'), entries: total }
}

/**
 * Interrupt a live session's turn.
 *
 * The phone kill switch: a turn started anywhere — here, the web UI, a cron
 * entry — that is heading somewhere wrong can be stopped from the channel.
 * `{kind: 'user'}` is the harness's own cause for a human interrupt, and it is
 * recorded on the turn's `turn/end` rather than inferred later.
 *
 * Queued and steering input goes with it (dsh's default): a cancel that left
 * the queue armed would restart the very work the user just stopped.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} sessionId - the session to interrupt.
 * @returns {object} what was interrupted.
 */
export function cancelSession(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short: shortId(sessionId) })

  const wasRunning = agent.status === 'running'
  const hadPending = agent.inbox?.hasPending === true
  agent.cancel({ kind: 'user' })

  return { short: shortId(sessionId), wasRunning, hadPending }
}

/**
 * Settings namespace the agent-preset roster reads its default from. Spelled
 * here rather than imported, because this package imports nothing from
 * `@deepseek-ai/*` — see `config.js` for why.
 */
const AGENT_PRESET_NAMESPACE = 'agent-presets'
/** Settings namespace the permission presets read their default from. */
const PERMISSION_NAMESPACE = 'permission'

/**
 * Read the agent preset roster and which one new sessions get.
 *
 * This is the deployment-wide default — dsh's own settings panel says as much:
 * a running session keeps the preset it was composed from, because the preset
 * supplies the agent's tools and prompt sections and those are mounted once.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {Promise<object>} owned roster and current default.
 */
export async function readAgentPresets(ctx) {
  const presets = requiredService(ctx, 'agentPresets')
  const rows = await presets.list()

  return {
    current: presets.defaultId,
    presets: rows.map((preset) => ({
      id: String(preset.id),
      name: preset.name,
      description: preset.description,
      trust: preset.trust,
      broken: preset.broken,
    })),
  }
}

/**
 * Switch the agent preset new sessions are composed from.
 *
 * A broken preset is refused here rather than at the next session's first turn:
 * the roster keeps unusable rows so their directories can be seen and removed,
 * and pinning one as the default would break session creation later, somewhere
 * else, with no trace of this command.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} id - the preset id to make default.
 * @returns {Promise<object>} the before and after ids.
 */
export async function switchAgentPreset(ctx, id) {
  const presets = requiredService(ctx, 'agentPresets')
  const wanted = String(id ?? '').trim()
  if (wanted.length === 0) throw new TranslatableError('error.noPreset')

  const rows = await presets.list()
  const target = rows.find((preset) => String(preset.id) === wanted)
  if (target === undefined) throw new TranslatableError('error.noSuchPreset', { id: wanted })
  if (target.broken !== undefined) throw new TranslatableError('error.brokenPreset', { id: wanted, reason: target.broken })

  const before = presets.defaultId

  const settings = ctx.get('settings')
  if (settings === undefined) throw new TranslatableError('error.presetNotSaved')
  await settings.update(AGENT_PRESET_NAMESPACE, { default: wanted })

  // Read back rather than trust the write: without a settings provider the
  // update is a no-op, and reporting a switch that did not happen would leave
  // every later session on a preset the operator believes they changed.
  const after = presets.defaultId
  if (after !== wanted) throw new TranslatableError('error.presetNotSaved')

  return { before, after, name: target.name ?? wanted }
}

/**
 * Read the permission presets: what they mean, what new sessions get, and —
 * when a live session is named — what that session is running under right now.
 *
 * The two are genuinely different facts. The default is a setting; a session's
 * effective permission is folded from its own log, because a switch made
 * mid-session is recorded there and outlives any setting.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} [sessionId] - a session to report the effective preset for.
 * @returns {Promise<object>} owned preset options and current selections.
 */
export async function readPermissionPresets(ctx, sessionId) {
  const permissions = requiredService(ctx, 'permissionPresets')

  const options = permissions.names.map((name) => {
    const option = permissions.optionOf(name)
    const spec = permissions.resolve(name)
    return {
      id: name,
      name: option?.name ?? name,
      description: option?.description,
      sandbox: spec?.sandbox,
      approval: spec?.approval,
    }
  })

  const agent = sessionId === undefined ? undefined : ctx.get('agents')?.get(sessionId)
  const session = agent?.session

  return {
    default: permissions.defaultPreset,
    options,
    session: session === undefined ? undefined : {
      id: String(session.id),
      short: shortId(String(session.id)),
      current: permissions.current(session.events),
    },
  }
}

/**
 * Switch a permission preset: the default for new sessions, or one live
 * session's own permission when `sessionId` is given.
 *
 * A session that is not live cannot be switched at all — its permission is a
 * fold over a log nothing is appending to — and saying so is better than
 * writing a setting the user believes changed the session in front of them.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} name - the preset to switch to.
 * @param {string} [sessionId] - a live session to switch instead of the default.
 * @returns {Promise<object>} what changed, and for which scope.
 */
export async function switchPermissionPreset(ctx, name, sessionId) {
  const permissions = requiredService(ctx, 'permissionPresets')

  const wanted = String(name ?? '').trim()
  if (wanted.length === 0) throw new TranslatableError('error.noPermission')
  if (!permissions.names.includes(wanted)) {
    throw new TranslatableError('error.noSuchPermission', { name: wanted, known: permissions.names.join(', ') })
  }

  if (sessionId !== undefined) {
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) throw new TranslatableError('error.sessionNotLive', { short: shortId(sessionId) })

    const before = permissions.current(agent.session.events)
    permissions.set(agent.session, wanted)
    return { scope: 'session', short: shortId(sessionId), before, after: permissions.current(agent.session.events) }
  }

  const before = permissions.defaultPreset

  const settings = ctx.get('settings')
  if (settings === undefined) throw new TranslatableError('error.permissionNotSaved')
  await settings.update(PERMISSION_NAMESPACE, { defaultPreset: wanted })

  const after = permissions.defaultPreset
  if (after !== wanted) throw new TranslatableError('error.permissionNotSaved')

  return { scope: 'default', before, after }
}

/**
 * Register a directory as a workspace.
 *
 * The registry canonicalizes the path and rejects one that does not exist or is
 * not a directory; repeating a registered path returns the existing record
 * rather than creating a duplicate.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} path - the directory to register.
 * @returns {Promise<object>} the owned workspace summary.
 */
export async function createWorkspace(ctx, path) {
  const registry = requiredService(ctx, 'workspaceRegistry')

  const wanted = path.trim()
  if (wanted.length === 0) throw new TranslatableError('error.noPath')
  if (!wanted.startsWith('/') && !wanted.startsWith('~')) {
    throw new TranslatableError('error.relativePath', { path: wanted })
  }

  const existing = registry.list().length
  const workspace = await registry.create(wanted)

  return {
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessions: workspace.sessionIds.length,
    alreadyRegistered: registry.list().length === existing,
  }
}

/**
 * Resolve a user-supplied session reference — a full id, a `session-` prefixed
 * id, or the short form shown in every listing — against one workspace.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the channel's workspace.
 * @param {string} input - the reference typed by the user.
 * @returns {Promise<string>} the full session id.
 */
export async function resolveSessionId(ctx, workspace, input) {
  const wanted = input.trim()
  if (wanted.length === 0) throw new TranslatableError('error.noSession')

  const sessions = await listWorkspaceSessions(ctx, workspace, 200)
  const exact = sessions.find((session) => session.id === wanted)
  if (exact !== undefined) return exact.id

  const matches = sessions.filter((session) => session.short.startsWith(wanted.toLowerCase()) || session.id.includes(wanted))
  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) throw new TranslatableError('error.ambiguousSession', { input: wanted, count: matches.length })
  throw new TranslatableError('error.noSuchSession', { input: wanted })
}

/**
 * The newest session of a workspace, used when a command omits its target.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the channel's workspace.
 * @returns {Promise<string>} the newest session id.
 */
export async function newestSessionId(ctx, workspace) {
  const sessions = await listWorkspaceSessions(ctx, workspace, 1)
  if (sessions.length === 0) throw new TranslatableError('error.emptyWorkspace')
  return sessions[0].id
}
