/**
 * The model selections this plugin installed on the agents it composed, so a
 * later switch can retarget one instead of only moving the deployment default.
 *
 * Why this is its own module rather than a detail of `run.js`: the ref is
 * written where an agent is composed (`run.js`) and read where a setting is
 * changed (`queries.js`), and `run.js` already imports `queries.js`. A shared
 * leaf both can import is the only arrangement that does not close that cycle.
 *
 * The map is weak on the agent: a session that goes away takes its ref with it,
 * and nothing here keeps a disposed agent alive.
 */

/** Refs installed by `composeAgent`, keyed by the agent they drive. */
const installed = new WeakMap()

/**
 * Record the selection ref installed on one agent.
 *
 * @param {object} agent - the agent whose scope carries the listeners.
 * @param {{current: object | undefined, assembled: object | undefined}} ref - the mutable selection.
 * @returns {void}
 */
export function rememberSelection(agent, ref) {
  installed.set(agent, ref)
}

/**
 * Point one of this plugin's own agents at a different model.
 *
 * Only the *next* turn moves, which is the same contract the harness's own
 * per-session switch offers: `installModelSelection` snapshots `current` into
 * `assembled` when the system prompt is assembled, and the request listener
 * reads the snapshot. A turn already in flight therefore finishes on the model
 * it started with rather than changing route mid-stream.
 *
 * @param {object} agent - the agent to retarget.
 * @param {{provider: string, model: string}} next - the selection to apply.
 * @returns {boolean} whether this plugin owns that agent's selection.
 */
export function retargetSelection(agent, next) {
  const ref = installed.get(agent)
  if (ref === undefined) return false
  ref.current = next
  return true
}
