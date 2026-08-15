/**
 * Every read this bot performs against the harness, in one place.
 *
 * Two rules hold throughout. First, harness objects are internal live data: a
 * query returns plain owned JSON built from scalar leaves, never a borrowed
 * record, header, or event. Second, nothing here writes — the bot exports
 * session content to a chat platform, so the read-only boundary is structural
 * rather than a policy check that a later command could forget.
 */

import { TranslatableError } from './i18n.js'

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

  const cacheRead = usage?.cacheReadTokens ?? 0
  const uncached = usage?.uncachedInputTokens ?? 0

  return {
    turns: stats?.turns ?? 0,
    steps: stats?.steps ?? 0,
    llmMs: stats?.llmMs ?? 0,
    toolMs: stats?.toolMs ?? 0,
    // An average, not a sum: dsh counts the steps that contributed a first
    // token separately, because not every step produces one.
    ttftMs: stats?.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : 0,
    tokensPerSecond: stats?.decodeMs > 0 ? (stats.decodeTokens / stats.decodeMs) * 1000 : 0,
    cacheHit: cacheRead + uncached > 0 ? cacheRead / (cacheRead + uncached) : 0,
    inputTokens: cacheRead + uncached,
    outputTokens: usage?.outputTokens ?? 0,
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
