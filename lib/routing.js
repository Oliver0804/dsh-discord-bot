import { listWorkspaces } from './workspaces.js'

/**
 * Which Discord channel a session's activity belongs in.
 *
 * The bot's own commands answer this backwards — a channel's topic names its
 * workspace — but anything that starts outside Discord arrives as a session id
 * and nothing else. Two hops close the gap: session to workspace (the
 * registry's account, or the session's cwd when the registry has not filed it),
 * then workspace to channel (the mapping the last reconcile produced).
 *
 * Everything here is cached, because the callers are an event feed that fires
 * per appended event and an approval waterfall that must not stall a turn.
 * Cache entries are short-lived and a negative answer is held for less time
 * than a positive one: a workspace whose channel does not exist yet is the
 * normal state for the few seconds before `session/created` reconciles it, and
 * an unresolvable session must not stay unresolvable once it does.
 */

/** How long a resolved session→channel answer is reused. */
const HIT_TTL_MS = 60_000
/** How long an unresolved one is, before another lookup is worth the cost. */
const MISS_TTL_MS = 10_000
/** How long the workspace and session listings behind a lookup stay warm. */
const LISTING_TTL_MS = 5_000

/**
 * Build a resolver over one bridge's channel mapping.
 * @param {object} args - resolver dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @returns {object} the resolver: `update`, `locate`, `forget`.
 */
export function createChannelResolver({ ctx }) {
  /** Workspace id to channel id, from the last reconcile. */
  let channels = new Map()
  /** @type {Map<string, {at: number, value: object}>} */
  const cache = new Map()

  /** @type {{at: number, value: Promise<object[]>} | undefined} */
  let workspaceListing
  /** @type {{at: number, value: Promise<object[]>} | undefined} */
  let sessionListing

  /**
   * Workspaces, warm for a few seconds. The promise itself is cached, so a
   * burst of events from several sessions shares one listing rather than
   * starting one per event.
   * @param {number} now - current wall clock.
   * @returns {Promise<object[]>} the workspace views.
   */
  function warmWorkspaces(now) {
    if (workspaceListing === undefined || now - workspaceListing.at >= LISTING_TTL_MS) {
      workspaceListing = { at: now, value: listWorkspaces(ctx).catch(() => []) }
    }
    return workspaceListing.value
  }

  /**
   * Session metadata records, warm for a few seconds.
   * @param {number} now - current wall clock.
   * @returns {Promise<object[]>} `sessionQuery.listSessions()` records.
   */
  function warmSessions(now) {
    if (sessionListing === undefined || now - sessionListing.at >= LISTING_TTL_MS) {
      const sessionQuery = ctx.get('sessionQuery')
      sessionListing = {
        at: now,
        value: sessionQuery === undefined ? Promise.resolve([]) : sessionQuery.listSessions().catch(() => []),
      }
    }
    return sessionListing.value
  }

  return {
    /**
     * Adopt the mapping a reconcile just produced, and drop cached misses so a
     * session that had no channel a moment ago resolves against the new one.
     * @param {Map<string, string>} mapping - channel id to workspace id.
     */
    update(mapping) {
      channels = new Map([...mapping].map(([channelId, workspaceId]) => [workspaceId, channelId]))
      for (const [sessionId, entry] of cache) {
        if (entry.value.channelId === undefined) cache.delete(sessionId)
      }
    },

    /** Drop one session's cached answer — used when its channel rejects a post. */
    forget(sessionId) {
      cache.delete(sessionId)
    },

    /**
     * Locate one session: its channel, and the facts a caller needs to decide
     * whether to report it at all.
     *
     * @param {string} sessionId - the session to place.
     * @returns {Promise<{channelId: string | undefined, isChild: boolean, title: string | undefined}>}
     *   the channel when one is mapped, whether the session is a subagent, and
     *   its workspace's title for display.
     */
    async locate(sessionId) {
      const now = Date.now()
      const hit = cache.get(sessionId)
      if (hit !== undefined) {
        const ttl = hit.value.channelId === undefined ? MISS_TTL_MS : HIT_TTL_MS
        if (now - hit.at < ttl) return hit.value
      }

      const [workspaces, records] = await Promise.all([warmWorkspaces(now), warmSessions(now)])
      const record = records.find((entry) => String(entry.header.id) === sessionId)

      // The registry's account is authoritative; a session it has not filed yet
      // still belongs to the workspace rooted at its cwd, which is the same
      // union `listWorkspaceSessions` reads for the command surface.
      const workspace = workspaces.find((entry) => entry.sessionIds.includes(sessionId))
        ?? (record === undefined ? undefined : workspaces.find((entry) => entry.path === record.header.cwd))

      const value = {
        channelId: workspace === undefined ? undefined : channels.get(workspace.id),
        isChild: record?.header.parentSession !== undefined,
        title: workspace?.title,
      }

      cache.set(sessionId, { at: now, value })
      return value
    },
  }
}
