import { listWorkspaceSessions } from './queries.js'
import { renderSessionCard } from './render.js'
import { described } from './util.js'

/**
 * Give the sessions that already exist a thread, so the channel's thread list
 * is the workspace's conversation list rather than only what has spoken since
 * the bot started.
 *
 * Without this, `sessionThreads` is invisible until something happens: threads
 * are opened lazily, on the first turn a session mirrors, so a person who turns
 * the setting on and opens Discord finds an empty thread panel and reasonably
 * concludes it did not work. Backfill is the difference between a feature that
 * announces itself and one that has to be triggered before it can be believed.
 *
 * It runs on every reconcile rather than once at boot, because "the threads
 * match the sessions" has to keep being true: a session created while the bot
 * was offline, or one whose announcement failed, would otherwise wait for a
 * restart to get its thread. Re-running is cheap by construction — a session
 * that already has a thread costs a cached lookup and nothing else, so the
 * steady state is a sweep that opens nothing and pauses for nothing.
 *
 * Two properties keep the first pass from being a stampede. It never blocks the
 * reconcile that starts it — the caller fires and forgets — and it paces itself
 * between threads it actually opens, because opening one and posting its card
 * are two Discord calls and a workspace tree is many sessions. A burst would
 * spend the global rate budget and stall the mirror behind it, which is a live
 * surface losing to a cosmetic one.
 */

/** Pause between threads actually opened: two Discord calls each, well inside the bucket. */
const PACE_MS = 500

/**
 * Build a backfiller over one bridge's resolver.
 *
 * @param {object} args - dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.resolver - the channel resolver, which owns thread placement.
 * @param {() => object | undefined} args.client - the connected Discord client.
 * @param {object} args.logger - the plugin logger.
 * @param {(key: string, params?: object) => string} args.t - translator.
 * @returns {{run: (workspaces: object[]) => void, idle: () => Promise<void>}} the backfiller.
 */
export function createThreadBackfill({ ctx, config, resolver, client, logger, t }) {
  /** Serializes every backfilled thread across every workspace. */
  let queue = Promise.resolve()
  /** Whether a sweep is already in flight, so reconciles cannot pile them up. */
  let sweeping = false

  /**
   * Open the thread for one session and give it something to open onto.
   *
   * The card is posted only when this call is what created the thread. A thread
   * adopted from a previous process already holds the session's history, and a
   * second card would be a duplicate at the top of it every time the bot
   * restarts.
   *
   * @param {object} session - the session summary.
   * @returns {Promise<boolean>} whether a thread was opened.
   */
  async function place(session) {
    const located = await resolver.locate(session.id)
    if (!located.threadCreated || located.channelId === undefined) return false

    const discord = client()
    const thread = await discord?.channels?.fetch(located.channelId).catch(() => null)
    if (thread === null || thread === undefined) return false

    await thread.send(await renderSessionCard(ctx, session, config, t))
    return true
  }

  return {
    /**
     * Backfill every mapped workspace, once per process.
     *
     * @param {object[]} workspaces - the workspaces a reconcile just mapped.
     * @returns {void} nothing; the work runs behind the caller.
     */
    run(workspaces) {
      if (!resolver.threaded || config.sessionThreadsBackfill <= 0) return

      // One sweep at a time. Reconciles fire on session creation and a run that
      // is still pacing through a first boot would otherwise be joined by
      // another for the same workspaces — and the second would find every
      // thread already open, having queued behind the first to learn it.
      if (sweeping) return
      sweeping = true

      queue = queue.then(async () => {
        let opened = 0
        for (const workspace of workspaces) {
          try {
            const sessions = await listWorkspaceSessions(ctx, workspace, config.sessionThreadsBackfill)
            for (const session of sessions) {
              if (!await place(session)) continue
              opened += 1
              // Paced only for threads actually opened. A steady-state sweep
              // opens none, so it costs cached lookups and no waiting at all —
              // which is what makes running this on every reconcile sane.
              await new Promise((resolve) => { setTimeout(resolve, PACE_MS) })
            }
          } catch (error) {
            logger?.warn('dsh-discord-bot: could not backfill threads for "%s": %s', workspace.title, described(error))
          }
        }

        if (opened > 0) logger?.info('dsh-discord-bot: opened %d session thread(s)', opened)
      }).finally(() => { sweeping = false })
    },

    /** Settle: the tests need a join point, and disposal wants one too. */
    idle() {
      return queue
    },
  }
}
