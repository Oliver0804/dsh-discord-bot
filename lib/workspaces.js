import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { readdir } from 'node:fs/promises'

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
 * Suggest directories for `/dsh workspace`.
 *
 * Typing an absolute path on a phone is the reason this exists: the harness
 * resolves nothing relative to Discord, so the only valid input is a full path,
 * and the only humane way to produce one on a touch keyboard is to pick it.
 *
 * Two modes. A path-shaped input completes against the filesystem, listing the
 * directories inside its parent. Anything else is treated as a name and matched
 * against the siblings of directories the harness already knows, which is what
 * turns `dsh-discord-bot` into `/Users/you/Documents/dsh/dsh-discord-bot`.
 *
 * @param {string} typed - what the user has entered so far.
 * @param {WorkspaceView[]} known - workspaces already registered.
 * @param {number} limit - maximum suggestions.
 * @returns {Promise<string[]>} absolute directory paths.
 */
export async function suggestDirectories(typed, known, limit) {
  const input = typed.trim()
  const home = homedir()
  const expand = (value) => (value.startsWith('~') ? join(home, value.slice(1)) : value)

  /**
   * Directory entries inside one parent, as absolute paths.
   * @param {string} parent - directory to read.
   * @param {string} prefix - required case-insensitive name prefix.
   * @returns {Promise<string[]>} matching absolute paths.
   */
  const childrenOf = async (parent, prefix) => {
    try {
      const entries = await readdir(parent, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .filter((entry) => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((entry) => join(parent, entry.name))
    } catch {
      return []
    }
  }

  if (input.startsWith('/') || input.startsWith('~')) {
    const full = expand(input)
    // A trailing slash means "inside this directory"; otherwise the last
    // segment is a partial name to match within its parent.
    const [parent, prefix] = full.endsWith('/') ? [full, ''] : [dirname(full), basename(full)]
    return (await childrenOf(parent, prefix)).slice(0, limit)
  }

  // Name search across the parents of directories the harness already knows —
  // the places this user actually keeps projects.
  const parents = [...new Set(known.map((workspace) => dirname(workspace.path)))]
  const found = []
  for (const parent of parents) {
    for (const path of await childrenOf(parent, '')) {
      if (input.length === 0 || basename(path).toLowerCase().includes(input.toLowerCase())) found.push(path)
      if (found.length >= limit) return found
    }
  }
  return found
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
