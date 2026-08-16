import { shortFromThreadName, threadName, THREAD_ARCHIVE_MINUTES } from './topology.js'
import { shortId } from './queries.js'
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
 * With `sessionThreads` there is a third hop, and it belongs here rather than
 * in any one caller: the mirror, the approval cards and the question cards all
 * place their messages through this resolver, and a deployment where the
 * transcript went to a thread while its approvals went to the parent channel
 * would be split exactly where it matters. A Discord thread *is* a channel — it
 * has a channel id, `channels.fetch` returns it, `isTextBased()` is true — so
 * answering with the thread's id keeps every one of those callers unchanged.
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
 * @param {() => object | undefined} [args.client] - the connected Discord client, when threads are wanted.
 * @param {object} [args.config] - the validated plugin config.
 * @returns {object} the resolver: `update`, `locate`, `adopt`, `forget`.
 */
export function createChannelResolver({ ctx, client, config }) {
  /** Workspace id to channel id, from the last reconcile. */
  let channels = new Map()
  /** @type {Map<string, {at: number, value: object}>} */
  const cache = new Map()

  /** Whether each session gets its own thread under the workspace channel. */
  const wantThreads = config?.sessionThreads === true
  /** Session id to thread id. Outlives the lookup cache: a thread is durable. */
  const threads = new Map()
  /** In-flight thread work, so two concurrent locates cannot open two threads. */
  const ensuring = new Map()
  /** Parent channels already swept for threads a previous process opened. */
  const swept = new Set()

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

  /**
   * The title to name one session's thread after.
   *
   * The session's own title when the harness has folded one, because that is
   * what makes a sidebar of threads readable; the workspace title otherwise. A
   * session usually has no title in the seconds after it is created, which is
   * exactly when its thread is opened — so this is best-effort by design, and
   * the name is never re-derived later. The short id in front is what
   * identifies the thread, and it is right from the first character.
   *
   * @param {string} sessionId - the session being threaded.
   * @param {string | undefined} fallback - the workspace title.
   * @returns {Promise<string | undefined>} the title half of the thread name.
   */
  async function titleFor(sessionId, fallback) {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery?.readTitleSnapshots === undefined) return fallback

    try {
      const [result] = await sessionQuery.readTitleSnapshots([sessionId])
      if (result?.status !== 'fulfilled') return fallback
      return result.value.title?.title ?? fallback
    } catch {
      return fallback
    }
  }

  /**
   * Adopt every managed thread a parent channel already holds.
   *
   * This is how a restart finds the threads the last process opened: the name
   * carries the short id, so one sweep per parent rebuilds the whole mapping
   * without any state written to disk. Archived threads are deliberately not
   * paginated — a session quiet for a day gets a fresh thread, and because the
   * name parses to the same short id, commands typed in either one still bind
   * to the same session. The cost of that is cosmetic.
   *
   * @param {object} parent - the workspace channel.
   * @returns {Promise<void>} resolution once the sweep settles.
   */
  async function sweep(parent) {
    if (swept.has(parent.id)) return
    swept.add(parent.id)

    const active = await parent.threads?.fetchActive?.().catch(() => undefined)
    for (const thread of active?.threads?.values() ?? []) {
      const short = shortFromThreadName(thread.name)
      if (short !== undefined) known.set(short, thread.id)
    }
  }

  /** Short id to thread id, for threads found by sweeping rather than opened here. */
  const known = new Map()

  /**
   * Open — or recover — the thread that carries one session.
   *
   * Serialized per session: two mirror ticks for one session arrive within
   * milliseconds of each other, and both would otherwise pass the "no thread
   * yet" check and open one each. A failure resolves to `undefined` rather than
   * rejecting, because every caller's fallback is the parent channel and a
   * message posted to the wrong place beats a message not posted at all.
   *
   * @param {string} sessionId - the session to place.
   * @param {string} parentId - the workspace channel it belongs under.
   * @param {string | undefined} title - the workspace title, as a name fallback.
   * @returns {Promise<string | undefined>} the thread id, when there is one.
   */
  function ensureThread(sessionId, parentId, title) {
    const held = threads.get(sessionId)
    if (held !== undefined) return Promise.resolve({ id: held, created: false })

    const inFlight = ensuring.get(sessionId)
    // A racing caller gets the same answer but never the `created` flag: only
    // the call that actually opened the thread may claim it, or two callers
    // would both post the summary card into one thread.
    if (inFlight !== undefined) return inFlight.then((result) => ({ id: result.id, created: false }))

    const work = openThread(sessionId, parentId, title)
      .catch(() => ({ id: undefined, created: false }))
      .then((result) => {
        if (result.id !== undefined) threads.set(sessionId, result.id)
        ensuring.delete(sessionId)
        return result
      })

    ensuring.set(sessionId, work)
    return work
  }

  /**
   * The uncached half of {@link ensureThread}.
   * @param {string} sessionId - the session to place.
   * @param {string} parentId - the workspace channel.
   * @param {string | undefined} title - the workspace title.
   * @returns {Promise<string | undefined>} the thread id, when one could be had.
   */
  async function openThread(sessionId, parentId, title) {
    const blank = { id: undefined, created: false }

    const discord = client?.()
    if (discord === undefined) return blank

    const parent = await discord.channels.fetch(parentId).catch(() => null)
    if (parent === null || typeof parent.threads?.create !== 'function') return blank

    const short = shortId(sessionId)
    await sweep(parent)

    // Adopted, not opened — a thread from a previous process already holds this
    // session's history, and posting a summary into it would be a duplicate.
    const found = known.get(short)
    if (found !== undefined) return { id: found, created: false }

    const opened = await parent.threads.create({
      name: threadName(short, await titleFor(sessionId, title)),
      autoArchiveDuration: THREAD_ARCHIVE_MINUTES,
      reason: `dsh session ${short}`,
    }).catch(() => null)

    if (opened === null) return blank
    known.set(short, opened.id)
    return { id: opened.id, created: true }
  }

  return {
    /**
     * Adopt a thread opened elsewhere — the announcement message starts one, so
     * the session's own line in the parent channel becomes the way into it.
     * @param {string} sessionId - the session the thread carries.
     * @param {string} threadId - the thread just opened for it.
     */
    adopt(sessionId, threadId) {
      threads.set(sessionId, threadId)
      known.set(shortId(sessionId), threadId)
    },

    /** Whether this resolver places sessions in their own threads. */
    threaded: wantThreads,

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

    /**
     * Drop one session's cached answer — used when its channel rejects a post.
     * The thread goes with it: the commonest reason a post is rejected is that
     * someone deleted the thread, and keeping its id would retry into the same
     * hole forever. Dropping it means the next lookup sweeps the parent again
     * and opens a replacement.
     */
    forget(sessionId) {
      cache.delete(sessionId)
      const threadId = threads.get(sessionId)
      threads.delete(sessionId)
      ensuring.delete(sessionId)
      if (threadId !== undefined) {
        known.delete(shortId(sessionId))
        // The sweep result is what would hand the dead id straight back.
        swept.clear()
      }
    },

    /**
     * Locate one session: where its messages go, and the facts a caller needs
     * to decide whether to report it at all.
     *
     * `channelId` is the destination and `parentId` is the workspace channel.
     * Without `sessionThreads` they are the same id, which is why every caller
     * that only ever knew about `channelId` keeps working.
     *
     * @param {string} sessionId - the session to place.
     * @returns {Promise<{channelId: string | undefined, parentId: string | undefined, isChild: boolean, title: string | undefined}>}
     *   the destination and its parent when one is mapped, whether the session
     *   is a subagent, and its workspace's title for display.
     */
    async locate(sessionId) {
      const now = Date.now()
      const hit = cache.get(sessionId)
      let placed = hit !== undefined && now - hit.at < (hit.value.parentId === undefined ? MISS_TTL_MS : HIT_TTL_MS)
        ? hit.value
        : undefined

      if (placed === undefined) {
        const [workspaces, records] = await Promise.all([warmWorkspaces(now), warmSessions(now)])
        const record = records.find((entry) => String(entry.header.id) === sessionId)

        // The registry's account is authoritative; a session it has not filed
        // yet still belongs to the workspace rooted at its cwd, which is the
        // same union `listWorkspaceSessions` reads for the command surface.
        const workspace = workspaces.find((entry) => entry.sessionIds.includes(sessionId))
          ?? (record === undefined ? undefined : workspaces.find((entry) => entry.path === record.header.cwd))

        placed = {
          parentId: workspace === undefined ? undefined : channels.get(workspace.id),
          isChild: record?.header.parentSession !== undefined,
          title: workspace?.title,
        }
        cache.set(sessionId, { at: now, value: placed })
      }

      // The thread is resolved outside the cache: it is durable where the
      // placement is a guess with a TTL, and a thread opened a moment ago must
      // be used immediately rather than after the cached miss expires.
      const thread = wantThreads && placed.parentId !== undefined && !(placed.isChild && config?.mirrorSubagents !== true)
        ? await ensureThread(sessionId, placed.parentId, placed.title)
        : undefined

      return { ...placed, channelId: thread?.id ?? placed.parentId, threadCreated: thread?.created === true }
    },
  }
}
