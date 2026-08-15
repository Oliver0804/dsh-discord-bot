import { basename } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * A workspace as this plugin sees it. Two sources produce the same shape:
 * `ctx.workspaceRegistry`, which the web bundle mounts and which owns durable
 * records and their manual order, and — when that service is absent, as in the
 * headless and tui profiles — a grouping synthesized from session header cwds.
 * Only scalar leaves are copied out; harness objects never leave this module.
 *
 * @typedef {object} WorkspaceView
 * @property {string} id - stable anchor written into the channel topic.
 * @property {string} title - display title, used for the channel name.
 * @property {string} path - canonical directory path.
 * @property {string[]} sessionIds - member sessions, newest-first.
 * @property {boolean} synthetic - true when grouped from cwds, not registered.
 */

/**
 * Derive a stable id for a workspace that has no registry record. Hashing the
 * canonical path keeps the channel mapping stable across restarts, which a
 * per-process counter would not.
 * @param {string} path - canonical directory path.
 * @returns {string} a stable synthetic workspace id.
 */
function syntheticId(path) {
  return `cwd-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`
}

/**
 * Read the registry's workspaces into detached views. `list()` is synchronous
 * and already in durable order, so this copies leaves and nothing else.
 * @param {object} registry - `ctx.workspaceRegistry`.
 * @returns {WorkspaceView[]} detached views in registry order.
 */
function fromRegistry(registry) {
  return registry.list().map((workspace) => ({
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionIds: workspace.sessionIds.map((id) => String(id)),
    synthetic: false,
  }))
}

/**
 * Group the session corpus by header cwd. Sessions without a cwd cannot belong
 * to a directory and are dropped rather than pooled into a fake workspace.
 * @param {object} sessionQuery - `ctx.sessionQuery`.
 * @returns {Promise<WorkspaceView[]>} views ordered by newest member session.
 */
async function fromSessionCwds(sessionQuery) {
  const records = await sessionQuery.listSessions()
  /** @type {Map<string, string[]>} */
  const byPath = new Map()

  // listSessions() is newest-first, so first insertion wins the ordering and
  // each group's own list stays newest-first too.
  for (const record of records) {
    const cwd = record.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    const bucket = byPath.get(cwd)
    if (bucket === undefined) byPath.set(cwd, [String(record.header.id)])
    else bucket.push(String(record.header.id))
  }

  return [...byPath].map(([path, sessionIds]) => ({
    id: syntheticId(path),
    title: basename(path) || path,
    path,
    sessionIds,
    synthetic: true,
  }))
}

/**
 * List every workspace the harness currently knows, preferring the durable
 * registry and falling back to cwd grouping when it is not mounted.
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {Promise<WorkspaceView[]>} detached workspace views.
 */
export async function listWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) return fromRegistry(registry)

  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) return []
  return fromSessionCwds(sessionQuery)
}

/**
 * Find one workspace by the id stored in a channel topic.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {string} workspaceId - the anchor read back from the channel topic.
 * @returns {Promise<WorkspaceView | undefined>} the view, or undefined when the
 *   workspace was deleted since the channel was created.
 */
export async function findWorkspace(ctx, workspaceId) {
  const all = await listWorkspaces(ctx)
  return all.find((workspace) => workspace.id === workspaceId)
}
