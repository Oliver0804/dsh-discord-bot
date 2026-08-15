import { ambientTranslator } from './i18n.js'
import { askOne } from './questions.js'
import { described } from './util.js'

/**
 * Answering the model's questions when something else owns the seam.
 *
 * `ctx.userQuestions` takes exactly one provider, and in a web profile
 * `dsh-host-apiproxy` has already claimed it by the time this bot connects —
 * see {@link import('./questions.js').installQuestionProvider}. Declining is
 * correct, but it leaves the phone case unserved: the whole point of this bot
 * is reaching a machine you are not sitting at, and a turn that stops to ask a
 * question stops for as long as nobody is at the browser.
 *
 * So this takes the other route in. The bot is a plugin inside the same cordis
 * context as the gateway, which means `ctx.apiProxy` is the very object the
 * browser talks to over HTTP — reachable here as a direct call, with no port,
 * no client credentials and no second carrier. Subscribing to its event mux
 * yields the same `question/requested` frames the web UI renders, and
 * `respond()` is the same entry point the web UI answers through.
 *
 * **Both surfaces stay live.** The gateway deletes a pending question
 * synchronously before settling it, so the first claimant wins and the loser is
 * told `not-pending`. Answer on your phone or at the browser, whichever you
 * reach first; the other card retracts itself.
 *
 * What this mode must *not* do is decide anything on the asker's behalf. It
 * does not own the ask, so an unanswered card expires quietly, saying to answer
 * in the web UI instead. Calling `respond()` with a cancellation would settle a
 * question the person at the browser is still looking at.
 */

/** Cards to retract when a question is settled somewhere else. */
const openAsks = new Map()

/**
 * Mirror the gateway's pending questions into Discord.
 *
 * @param {object} args - mirror dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.logger - the plugin logger.
 * @param {() => import('discord.js').Client | undefined} args.client - the live client.
 * @param {object} args.resolver - the shared channel resolver.
 * @param {Map<string, {channelId: string}>} args.runs - sessions this plugin is driving.
 * @returns {(() => void) | undefined} the disposer, or undefined when the
 *   gateway is not composed in this profile.
 */
export function installQuestionMirror({ ctx, config, logger, client, resolver, runs }) {
  const apiProxy = ctx.get('apiProxy')
  if (apiProxy === undefined) return undefined

  // Nobody's locale to follow — the question arrives from the harness, not
  // from someone typing in Discord — so `auto` falls back to the guild's own.
  const t = ambientTranslator(config, () => client()?.guilds?.cache?.get(config.guildId)?.preferredLocale)

  const controller = new AbortController()

  /**
   * The channel one session's questions belong in.
   * @param {string} sessionId - the session that is asking.
   * @returns {Promise<object | undefined>} a text channel, when one resolves.
   */
  async function channelFor(sessionId) {
    const channelId = runs.get(sessionId)?.channelId ?? (await resolver.locate(sessionId)).channelId
    if (channelId === undefined) return undefined

    const discord = client()
    if (discord === undefined) return undefined

    const channel = await discord.channels.fetch(channelId).catch(() => null)
    return channel !== null && channel.isTextBased() ? channel : undefined
  }

  /**
   * Put one request's questions to Discord and answer the gateway with them.
   *
   * The gateway validates the batch as a whole — one answer per question, in
   * order, every selected label drawn from that question's own options — so
   * nothing is sent until every question has been answered here.
   *
   * @param {string} rpcId - the gateway's id for this ask.
   * @param {{sessionId: string, questions: object[]}} payload - the request.
   * @returns {Promise<void>} resolution once the ask is answered or abandoned.
   */
  async function present(rpcId, payload) {
    const sessionId = String(payload.sessionId ?? '')
    const questions = payload.questions ?? []
    if (sessionId === '' || questions.length === 0) return

    const channel = await channelFor(sessionId)
    // A workspace with no channel yet is the mirror's business to skip, not to
    // report: the web UI is still showing this question to whoever is there.
    if (channel === undefined) return

    const retraction = new AbortController()
    openAsks.set(rpcId, retraction)

    try {
      const answers = []
      for (const [index, question] of questions.entries()) {
        answers.push(await askOne({
          channel,
          sessionId,
          question,
          position: index + 1,
          total: questions.length,
          signal: retraction.signal,
          config,
          t,
          expiryNotice: 'question.expiredElsewhere',
          withdrawnNotice: 'question.answeredElsewhere',
        }))
      }

      const outcome = await apiProxy.respond({
        rpcId,
        result: { ok: true, value: { sessionId, answer: { answers } } },
      })

      if (outcome?.accepted === true) {
        logger.info('dsh-discord-bot: answered a harness question from Discord (session %s)', sessionId)
        return
      }
      // `not-pending` is the ordinary race — somebody answered at the browser
      // between this card being filled in and the answer arriving. Anything
      // else means the batch this built was malformed, which is a bug here.
      if (outcome?.reason === 'not-pending') {
        logger.info('dsh-discord-bot: a question was answered elsewhere first (session %s)', sessionId)
      } else {
        logger.warn('dsh-discord-bot: the gateway refused an answer from Discord (%s); this is a bug in the answer shape', outcome?.reason ?? 'unknown')
      }
    } catch (error) {
      // An expired or retracted card is not a failure: this mode never owns
      // the ask, and the question is still answerable where it came from.
      if (error?.code !== 'ASK_CANCELLED') {
        logger.warn('dsh-discord-bot: mirroring a question failed: %s', described(error))
      }
    } finally {
      openAsks.delete(rpcId)
    }
  }

  void (async () => {
    try {
      // The mux is the whole web-UI firehose — every session event, tool call
      // and job view. Everything but a question is dropped on the spot: the
      // queue behind it is unbounded, so a slow reader here would grow the
      // host's memory rather than merely lag.
      for await (const frame of apiProxy.events.mux({}, controller.signal)) {
        const payload = frame?.payload
        if (payload?.type === 'question/requested') {
          void present(frame.rpcId, payload)
        } else if (payload?.type === 'question/resolved') {
          openAsks.get(payload.questionRpcId)?.abort()
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn('dsh-discord-bot: the question mirror stopped: %s', described(error))
      }
    }
  })()

  logger.info('dsh-discord-bot: mirroring the harness\'s user questions into Discord; either surface can answer')
  return () => {
    controller.abort()
    for (const retraction of openAsks.values()) retraction.abort()
    openAsks.clear()
  }
}
