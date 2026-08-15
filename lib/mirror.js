import { EmbedBuilder } from 'discord.js'

import { actionButtons } from './actions.js'

import { displayEntry, renderTurnBody } from './run.js'
import { todoLine } from './render.js'
import { ambientTranslator } from './i18n.js'
import { shortId } from './queries.js'
import { described } from './util.js'

/**
 * Push the harness's own activity into Discord, whoever started it.
 *
 * The command surface is a pull: you ask, the bot reads. That leaves the case
 * this module exists for — work begun in the web UI, the tui, a cron entry, or
 * any other entry point — visible only to someone who thinks to ask. The mirror
 * subscribes to the append feed instead and reports each turn into the channel
 * its workspace maps to.
 *
 * Three properties make that survivable rather than a firehose.
 *
 * **One message per turn, rewritten.** Discord allows roughly five messages per
 * five seconds per channel and a busy turn emits hundreds of events, so a turn
 * is a single message edited on a timer — the same shape `/dsh run` already
 * uses, and the same renderer, so a mirrored turn and a driven one read alike.
 *
 * **Nothing is mirrored twice.** A turn this bot drives is already reported by
 * `runTurn` into the reply that started it; those sessions are in `runs` for
 * exactly as long as the run is in flight, and the mirror skips them.
 *
 * **The feed is observed, never answered.** This module posts; it never calls
 * back into the harness. A Discord outage costs visibility and nothing else.
 */

/** How often buffered turns are rendered into Discord. */
const TICK_MS = 3000
/**
 * Silence after which an unclosed turn is finalized anyway. Generous on
 * purpose: a single model call can think for a minute before it emits anything,
 * and splitting one turn across two messages because of that would be worse
 * than waiting. `turn/end` is the normal way a turn closes; this is the backstop
 * for a bot that connected mid-turn and will never see one.
 */
const QUIET_MS = 120_000
/**
 * API calls one channel may receive per tick. Discord's per-channel budget is
 * about five messages per five seconds; two per three-second tick leaves room
 * for the command surface to answer in the same channel.
 */
const CALLS_PER_TICK = 2
/**
 * How long anything waits for a channel that does not exist yet. A workspace
 * created moments ago gets one on the next reconcile; one that never does must
 * not hold a buffered turn for the lifetime of the process.
 */
const GRACE_MS = 120_000
/** Announcements posted per tick, so a burst of new sessions cannot flood. */
const ANNOUNCE_PER_TICK = 2
/** Consecutive Discord failures after which a session stops being mirrored. */
const FAILURE_LIMIT = 3
/**
 * Characters kept per buffered entry. `displayEntry` returns tool results
 * verbatim, and a single file read can be megabytes — none of which any
 * renderer can show, since the widest one spends 3000 characters on the whole
 * message. Clipping at the door is what keeps a half-hour turn from buffering
 * the transcript of everything it read.
 */
const ENTRY_CHARS = 3000
/**
 * Entries kept per turn. The renderers only ever reach for the newest of them
 * plus the prompt, so the middle of a very long turn is dropped rather than
 * held; the tool count is carried separately so it stays honest.
 */
const ENTRY_LIMIT = 200

/**
 * Build the mirror for one bridge.
 *
 * @param {object} args - mirror dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.logger - the plugin logger.
 * @param {() => import('discord.js').Client | undefined} args.client - the live client.
 * @param {Map<string, {channelId: string}>} args.runs - sessions this plugin is driving.
 * @param {object} args.resolver - the shared channel resolver.
 * @param {object} [args.activity] - the live-status tracker, when one is running.
 * @returns {object} the mirror: `start` and `stop`.
 */
export function createMirror({ ctx, config, logger, client, runs, resolver, activity }) {
  // No interacting human to follow, so `auto` falls back to the guild's own
  // preferred locale rather than English — see `ambientTranslator`.
  const t = ambientTranslator(config, () => client()?.guilds?.cache?.get(config.guildId)?.preferredLocale)

  /**
   * One turn in flight, per session.
   * @type {Map<string, {entries: object[], dirty: boolean, done: boolean, lastAt: number, message: object | undefined, channelId: string | undefined, failures: number, posting: boolean}>}
   */
  const turns = new Map()
  /**
   * Sessions that appeared while the mirror was running, waiting for a channel.
   * @type {Map<string, {at: number}>}
   */
  const announcements = new Map()

  /** @type {NodeJS.Timeout | undefined} */
  let timer
  let ticking = false
  let stopped = false
  /** @type {(() => void)[]} */
  const listeners = []

  /**
   * A fresh, empty turn record.
   * @param {number} at - the wall clock of the event opening it.
   * @returns {object} the turn state.
   */
  const blank = (at) => ({
    entries: [],
    todos: [],
    tools: 0,
    dirty: false,
    done: false,
    lastAt: at,
    message: undefined,
    channelId: undefined,
    failures: 0,
    posting: false,
  })

  /**
   * Whether this session's events belong to Discord's own run, which is already
   * being reported into the reply that started it.
   * @param {string} sessionId - the session the event came from.
   * @returns {boolean} true when the mirror must stay out of the way.
   */
  const driven = (sessionId) => runs.has(sessionId)

  /**
   * Turns superseded by a following `turn/start`, kept until they are posted.
   * @type {[string, object][]}
   */
  const finished = []

  /**
   * Buffer one appended event. Runs inside the harness's append path, so it
   * does exactly two things — classify and enqueue — and never awaits.
   * @param {object} session - the session whose log grew.
   * @param {object} event - the appended event.
   */
  function onEvent(session, event) {
    const sessionId = String(session.id)
    if (driven(sessionId)) return

    const now = Date.now()

    // A new turn supersedes whatever is buffered: the previous one is finalized
    // on the next tick and this one starts its own message.
    if (event.type === 'turn/start') {
      const previous = turns.get(sessionId)
      if (previous !== undefined && previous.entries.length > 0) {
        previous.done = true
        previous.dirty = true
        finished.push([sessionId, previous])
      }
      turns.set(sessionId, blank(now))
      return
    }

    const state = turns.get(sessionId)

    if (event.type === 'turn/end') {
      if (state === undefined) return
      state.done = true
      state.dirty = true
      state.lastAt = now
      return
    }

    // The todo list is a whole-list snapshot, not a narrative line: the latest
    // write replaces the previous one. Handled here rather than through
    // `NARRATIVE_TYPES`, which is the shared vocabulary `/dsh trace` reads —
    // adding a type there would change what a trajectory shows.
    if (event.type === 'todo/write') {
      const target = turns.get(sessionId)
      if (target === undefined) return
      target.todos = Array.isArray(event.data?.todos) ? event.data.todos : []
      target.dirty = true
      target.lastAt = now
      return
    }

    const entry = displayEntry(event)
    if (entry === undefined) return

    // The bot may have connected mid-turn, in which case no `turn/start` was
    // seen; the first entry opens one rather than being dropped.
    const target = state ?? blank(now)
    if (state === undefined) turns.set(sessionId, target)

    if (entry.label === '🔧') target.tools += 1

    target.entries.push({ label: entry.label, text: entry.text.slice(0, ENTRY_CHARS) })
    // Past the cap, drop from the front — but never the prompt, which heads the
    // card and is the one line that says what this turn is about.
    if (target.entries.length > ENTRY_LIMIT) {
      target.entries.splice(target.entries[0].label === '👤' ? 1 : 0, 1)
    }

    target.dirty = true
    target.lastAt = now
  }

  /**
   * Note a session that has just been published, so its channel says so.
   * @param {object} session - the newly created session.
   */
  function onCreated(session) {
    const sessionId = String(session.id)
    if (driven(sessionId)) return

    // The store announces a RESUMED session the same way it announces a new
    // one — it is entering the store either way — so without this every
    // harness restart posts "a new session started here" for each session it
    // reloaded. A genuinely new session has an empty log at this moment; a
    // resumed one arrives carrying its history.
    if ((session.events?.length ?? 0) > 0) return

    announcements.set(sessionId, { at: Date.now() })
  }

  /**
   * Resolve the text channel for one session, honouring the subagent setting.
   * @param {string} sessionId - the session to place.
   * @returns {Promise<{channel: object, title: string | undefined} | undefined>} the channel, when it should be posted to.
   */
  async function channelFor(sessionId) {
    const located = await resolver.locate(sessionId)
    if (located.channelId === undefined) return undefined
    if (located.isChild && !config.mirrorSubagents) return undefined

    const discord = client()
    if (discord === undefined) return undefined

    const channel = await discord.channels.fetch(located.channelId).catch(() => null)
    if (channel === null || !channel.isTextBased()) return undefined
    return { channel, title: located.title }
  }

  /**
   * Render one turn as an embed payload.
   * @param {string} sessionId - the session being mirrored.
   * @param {object} state - the buffered turn.
   * @param {string | undefined} title - the workspace title.
   * @returns {object} a Discord message payload.
   */
  function frame(sessionId, state, title) {
    // `agent/status` is the harness saying so; the silence window is only a
    // guess for a turn whose agent this bot cannot see (already disposed, or a
    // status feed the profile does not emit).
    const live = activity?.statusOf(sessionId)
    const heading = state.done
      ? t('mirror.done')
      : live === 'running'
        ? t('mirror.running')
        : live === 'idle'
          ? t('mirror.idle')
          : (Date.now() - state.lastAt >= QUIET_MS ? t('mirror.idle') : t('mirror.running'))

    const todos = todoLine(state.todos, t)

    const prompt = state.entries.find((entry) => entry.label === '👤')
    const head = prompt === undefined ? '' : `> ${prompt.text.replace(/\s*\n\s*/g, ' ').slice(0, 300)}\n\n`
    const body = renderTurnBody(state.entries, {
      verbosity: config.runVerbosity,
      status: heading,
      done: state.done,
      toolCount: state.tools,
      t,
    })

    return {
      embeds: [new EmbedBuilder()
        .setColor(state.done ? 0x57f287 : 0x5865f2)
        .setTitle(`🪞 ${title ?? t('mirror.workspace')}`)
        .setDescription(`${head}${body}${todos === undefined ? '' : `\n\n${todos}`}`.slice(0, 4000))
        .setFooter({ text: t('mirror.footer', { short: shortId(sessionId) }) })],
      components: actionButtons(shortId(sessionId), { allowRun: config.allowRun, done: state.done, t }),
    }
  }

  /**
   * Write one turn's current state into its channel, creating the message the
   * first time and editing it afterwards.
   * @param {string} sessionId - the session being mirrored.
   * @param {object} state - the buffered turn.
   * @returns {Promise<boolean>} whether the turn reached a channel.
   */
  async function post(sessionId, state) {
    const placed = await channelFor(sessionId)
    if (placed === undefined) {
      // No channel yet — the `session/created` reconcile may still create one,
      // so keep buffering rather than discarding what has been said. Reporting
      // this as "not delivered" is what keeps the caller from forgetting it.
      state.channelId = undefined
      return false
    }

    const payload = frame(sessionId, state, placed.title)
    if (state.message === undefined) state.message = await placed.channel.send(payload)
    else await state.message.edit(payload)
    state.channelId = placed.channel.id
    state.failures = 0
    return true
  }

  /**
   * Post the "a session just started" line for one session.
   *
   * Three outcomes, not two: a subagent nobody asked to see is *dropped*
   * without spending an API call, which is what keeps a fan-out of children
   * from consuming the per-tick budget that a real session's line needs.
   *
   * @param {string} sessionId - the newly created session.
   * @returns {Promise<'sent' | 'dropped' | 'pending'>} what became of it.
   */
  async function announce(sessionId) {
    const located = await resolver.locate(sessionId)

    // A subagent nobody asked to see can never be announced. Reporting it as
    // settled is what removes it from the queue; leaving it as "no channel yet"
    // would let a fan-out of children spend every announcement slot for the
    // whole grace window, and a root session's line would wait behind them.
    if (located.isChild && !config.mirrorSubagents) return 'dropped'
    if (located.channelId === undefined) return 'pending'

    const discord = client()
    if (discord === undefined) return 'pending'

    const channel = await discord.channels.fetch(located.channelId).catch(() => null)
    if (channel === null || !channel.isTextBased()) return 'pending'

    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x99aab5)
        .setDescription(t('mirror.created', { short: shortId(sessionId) }))],
    })
    return 'sent'
  }

  /**
   * Drain what has accumulated: finalize closed turns, refresh live ones, and
   * announce new sessions — each channel within its call budget.
   * @returns {Promise<void>} resolution once this pass settles.
   */
  async function tick() {
    if (ticking || stopped) return

    // Not connected — a login retry, or a token that will never work. Nothing
    // can be posted, so age out what has piled up instead of buffering the
    // whole harness's activity into memory for as long as the process lives.
    if (client() === undefined) {
      const cutoff = Date.now() - GRACE_MS
      for (const [sessionId, state] of turns) if (state.lastAt < cutoff) turns.delete(sessionId)
      for (const [sessionId, pending] of announcements) if (pending.at < cutoff) announcements.delete(sessionId)
      while (finished.length > 0 && finished[0][1].lastAt < cutoff) finished.shift()
      return
    }

    ticking = true

    /** Calls spent per channel this pass; an unresolved channel bills nothing. */
    const spent = new Map()
    const budgeted = (channelId) => {
      if (channelId === undefined) return true
      const used = spent.get(channelId) ?? 0
      if (used >= CALLS_PER_TICK) return false
      spent.set(channelId, used + 1)
      return true
    }

    try {
      const now = Date.now()

      // Superseded turns first: they are complete, and holding them back would
      // let the next turn's message land above the answer it replaced.
      while (finished.length > 0) {
        const [sessionId, state] = finished[0]
        if (!budgeted(state.channelId)) break

        const delivered = await post(sessionId, state).catch((error) => {
          logger.debug('dsh-discord-bot: mirror could not post a finished turn: %s', described(error))
          return true
        })
        // Undelivered means the workspace has no channel yet. Keep it queued
        // until the reconcile that creates one — but not forever, or a
        // workspace that never gets a channel would hold the queue for the
        // lifetime of the process.
        if (delivered) finished.shift()
        else if (now - state.lastAt >= GRACE_MS) finished.shift()
        else break
      }

      for (const [sessionId, state] of [...turns]) {
        if (state.posting) continue

        const quiet = now - state.lastAt >= QUIET_MS
        if (!state.dirty && !quiet) continue
        // A quiet turn with nothing pending is finished as far as anyone can
        // tell; drop it so a later event opens a fresh message.
        if (quiet && !state.dirty) {
          turns.delete(sessionId)
          continue
        }
        if (!budgeted(state.channelId)) continue

        state.posting = true
        state.dirty = false
        try {
          const delivered = await post(sessionId, state)
          if (!delivered) {
            // Nothing was written, so this turn is still pending, not stale.
            state.dirty = true
            if (now - state.lastAt >= GRACE_MS) turns.delete(sessionId)
          } else if (state.done || quiet) {
            turns.delete(sessionId)
          }
        } catch (error) {
          state.failures += 1
          resolver.forget(sessionId)
          if (state.failures >= FAILURE_LIMIT) {
            turns.delete(sessionId)
            logger.warn('dsh-discord-bot: mirror gave up on session %s: %s', shortId(sessionId), described(error))
          }
        } finally {
          state.posting = false
        }
      }

      let announced = 0
      for (const [sessionId, pending] of [...announcements]) {
        if (announced >= ANNOUNCE_PER_TICK) break

        let outcome = 'dropped'
        try {
          outcome = await announce(sessionId)
        } catch (error) {
          logger.debug('dsh-discord-bot: mirror could not announce a session: %s', described(error))
        }

        // Only a real post is billed against the budget. Give up on a pending
        // one once the grace window passes: a session whose workspace never
        // gets a channel would otherwise be retried forever.
        if (outcome === 'sent') announced += 1
        if (outcome !== 'pending' || now - pending.at >= GRACE_MS) announcements.delete(sessionId)
      }
    } finally {
      ticking = false
    }
  }

  return {
    /** Subscribe to the harness feed and start the render timer. */
    start() {
      listeners.push(ctx.on('session/event', onEvent))
      if (config.mirrorNewSessions) listeners.push(ctx.on('session/created', onCreated))

      timer = setInterval(() => {
        void tick().catch((error) => {
          logger.debug('dsh-discord-bot: mirror tick failed: %s', described(error))
        })
      }, TICK_MS)
      // The mirror must not hold the process open on its own.
      timer.unref?.()
    },

    /** Stop observing. Buffered turns are dropped, not flushed: teardown is
     * already tearing the client down and a rejected send would only delay it. */
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      for (const dispose of listeners.splice(0)) {
        try {
          dispose()
        } catch {
          // a listener that is already gone is not a failure
        }
      }
      turns.clear()
      announcements.clear()
      finished.length = 0
    },

    /** Test seam: the buffered turn for one session, if any. */
    peek: (sessionId) => turns.get(sessionId),
    /** Test seam: how many announcements are still queued. */
    pending: () => announcements.size,
    /** Test seam: note a session as the `session/created` feed would. */
    note: onCreated,
    /** Test seam: drive one render pass without waiting for the timer. */
    flush: tick,
    /** Test seam: feed one event as the harness would. */
    observe: onEvent,
  }
}
