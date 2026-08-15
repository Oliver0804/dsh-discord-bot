/**
 * Which agents are working right now.
 *
 * Everything else in this package reads the durable log, which says what
 * happened but not whether anything is happening. `agent/status` is the
 * harness's own answer — `idle` or `running`, emitted on every transition —
 * and it is the difference between "this session has been quiet for two
 * minutes" and "this session is thinking about a hard question".
 *
 * The feed is global for an unscoped listener, the same property that lets the
 * mirror observe every session, so one tracker covers the whole harness. It
 * holds nothing but a status per live agent and forgets each on disposal.
 */

/**
 * Track live agent status for the bridge.
 * @param {object} args - tracker dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @returns {object} the tracker.
 */
export function createActivityTracker({ ctx }) {
  /** @type {Map<string, 'idle' | 'running'>} */
  const statuses = new Map()
  /** @type {(() => void)[]} */
  const listeners = []

  return {
    /** Subscribe to the status feed. */
    start() {
      listeners.push(ctx.on('agent/status', (payload) => {
        const id = payload?.agent?.id
        if (id === undefined) return
        statuses.set(String(id), payload.status)
      }))

      // Disposal is not a third status: the agent is gone, and remembering a
      // stale `idle` for it would make `/dsh status` count sessions that no
      // longer exist.
      listeners.push(ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id
        if (id !== undefined) statuses.delete(String(id))
      }))
    },

    /** Unsubscribe and forget everything. */
    stop() {
      for (const dispose of listeners.splice(0)) {
        try {
          dispose()
        } catch {
          // a listener already gone is not a failure
        }
      }
      statuses.clear()
    },

    /**
     * One session's live status.
     * @param {string} sessionId - the session to ask about.
     * @returns {'idle' | 'running' | undefined} its status, or undefined when
     *   no live agent drives it.
     */
    statusOf(sessionId) {
      return statuses.get(sessionId)
    },

    /** @param {string} sessionId - the session to ask about. @returns {boolean} whether a turn is in flight. */
    isRunning(sessionId) {
      return statuses.get(sessionId) === 'running'
    },

    /** @returns {number} how many agents are mid-turn across the harness. */
    runningCount() {
      let count = 0
      for (const status of statuses.values()) if (status === 'running') count += 1
      return count
    },

    /** Test seam: feed a status transition as the harness would. */
    observe(payload) {
      const id = payload?.agent?.id
      if (id === undefined) return
      if (payload.status === undefined) statuses.delete(String(id))
      else statuses.set(String(id), payload.status)
    },
  }
}
