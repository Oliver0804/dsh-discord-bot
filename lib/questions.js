import { ActionRowBuilder, ComponentType, EmbedBuilder, MessageFlags, StringSelectMenuBuilder } from 'discord.js'

import { isAuthorized } from './config.js'
import { ambientTranslator } from './i18n.js'
import { shortId } from './queries.js'
import { described } from './util.js'

/**
 * Answering the model's questions from Discord.
 *
 * `ask_user_question` parks a tool call until a human answers. The harness
 * routes it through `ctx.userQuestions`, and the difference from approvals is
 * the whole design constraint here: **approvals are a waterfall, questions have
 * a single provider**. There is no `next()` to hand a question back with, and
 * `registerProvider` throws `DUPLICATE_PROVIDER` if anything already owns the
 * seam.
 *
 * Two consequences, both deliberate:
 *
 * **Off by default.** In a web profile `dsh-host-apiproxy` registers first and
 * owns the seam — this bot then declines quietly, which is correct: the person
 * at the browser is watching for that questionnaire. But load order is not
 * guaranteed everywhere, and a plugin that grabbed the seam by default could
 * make someone's UI throw at boot. Claiming it is an operator's decision.
 *
 * **A timeout must reject, not decide.** With nobody to delegate to, an
 * unanswered question would otherwise block the tool call forever. The
 * rejection carries `ASK_CANCELLED`, which is what dsh's plan mode reads to
 * report "the user dismissed the review" rather than a generic failure.
 */

/** How long one question waits before the ask is rejected. */
const ANSWER_TIMEOUT_MS = 900_000
/** Discord's ceiling on select options. */
const OPTION_LIMIT = 25

/**
 * Register this bot as the harness's question provider.
 *
 * @param {object} args - provider dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.logger - the plugin logger.
 * @param {() => import('discord.js').Client | undefined} args.client - the live client.
 * @param {object} args.resolver - the shared channel resolver.
 * @param {Map<string, {channelId: string}>} args.runs - sessions this plugin is driving.
 * @returns {(() => void) | undefined} the disposer, or undefined when the seam
 *   is unavailable or already owned.
 */
export function installQuestionProvider({ ctx, config, logger, client, resolver, runs }) {
  const service = ctx.get('userQuestions')
  if (service === undefined) {
    logger.warn('dsh-discord-bot: `answerQuestions` is on but this profile composes no user-questions service; ignoring it')
    return undefined
  }

  // No interacting human to follow, so `auto` falls back to the guild's own
  // preferred locale rather than English — see `ambientTranslator`.
  const t = ambientTranslator(config, () => client()?.guilds?.cache?.get(config.guildId)?.preferredLocale)

  /** Serializes concurrent asks — subagents can ask while a parent waits. */
  let queue = Promise.resolve()

  /**
   * Cancel one ask, distinguishably. `ASK_CANCELLED` is dsh's own code for a
   * human dismissal; plan mode branches on it.
   * @param {string} message - the human-readable reason.
   * @returns {Error} the rejection value.
   */
  const cancelled = (message) => Object.assign(new Error(message), { code: 'ASK_CANCELLED' })

  /**
   * Where one ask should be answered: the channel its session maps to.
   * @param {object} request - the ask request.
   * @returns {Promise<object | undefined>} a text channel, when one resolves.
   */
  async function channelFor(request) {
    const sessionId = String(request.agent?.session?.id ?? request.agent?.id ?? '')
    if (sessionId === '') return undefined

    const channelId = runs.get(sessionId)?.channelId ?? (await resolver.locate(sessionId)).channelId
    if (channelId === undefined) return undefined

    const discord = client()
    if (discord === undefined) return undefined

    const channel = await discord.channels.fetch(channelId).catch(() => null)
    return channel !== null && channel.isTextBased() ? { channel, sessionId } : undefined
  }

  /**
   * Put one question to the channel and wait for an answer.
   * @param {object} args - question inputs.
   * @returns {Promise<object>} the answer item for this question.
   */
  async function askOne({ channel, sessionId, question, position, total, signal }) {
    const options = (question.options ?? []).slice(0, OPTION_LIMIT)
    // Discord can offer choices; it cannot prompt for free text without a modal
    // opened from an interaction the user started. An open-ended question has
    // no menu to render, and inventing an answer would be worse than saying so.
    if (options.length === 0) throw cancelled('this question has no options; Discord can only answer a menu')

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(t('question.title', { position, total }))
      .setDescription(`**${String(question.question).slice(0, 1000)}**${question.detail === undefined ? '' : `\n\n${String(question.detail).slice(0, 2000)}`}`)
      .setFooter({ text: t('question.footer', { short: shortId(sessionId), minutes: Math.round(ANSWER_TIMEOUT_MS / 60_000) }) })

    const select = new StringSelectMenuBuilder()
      .setCustomId(`dsh-question-${position}`)
      .setPlaceholder(t('question.pick'))
      .addOptions(options.map((option, index) => ({
        label: String(option.label).slice(0, 100),
        value: String(index),
        description: option.description === undefined ? undefined : String(option.description).slice(0, 100),
      })))

    if (question.multiSelect === true) select.setMinValues(1).setMaxValues(options.length)

    const card = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })

    const chosen = await new Promise((resolve, reject) => {
      const collector = card.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: ANSWER_TIMEOUT_MS,
      })

      const onAbort = () => collector.stop('aborted')
      signal?.addEventListener('abort', onAbort, { once: true })

      collector.on('collect', async (interaction) => {
        // The same allowlist as every other write surface: seeing the channel
        // is not permission to answer for the person running the harness.
        if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
          await interaction.reply({ content: t('question.notAllowed'), flags: MessageFlags.Ephemeral }).catch(() => {})
          return
        }

        const labels = interaction.values.map((value) => options[Number(value)]?.label).filter((label) => label !== undefined)
        await interaction.update({
          embeds: [EmbedBuilder.from(embed).setColor(0x57f287).setFooter({ text: t('question.answered', { user: interaction.user.tag }) })],
          components: [],
        }).catch(() => {})

        collector.stop('answered')
        resolve(labels)
      })

      collector.on('end', (_collected, reason) => {
        signal?.removeEventListener('abort', onAbort)
        if (reason === 'answered') return

        void card.edit({
          embeds: [EmbedBuilder.from(embed).setColor(0x99aab5).setFooter({ text: t(reason === 'aborted' ? 'question.withdrawn' : 'question.timedOut') })],
          components: [],
        }).catch(() => {})

        reject(cancelled(reason === 'aborted' ? 'the asker withdrew the question' : 'nobody answered in time'))
      })
    })

    return { id: question.id, selected: chosen }
  }

  /**
   * The provider entry point: one ask, questions in order.
   * @param {object} request - the harness's ask request.
   * @returns {Promise<object>} the collected answer.
   */
  async function ask(request) {
    const run = queue.then(async () => {
      const placed = await channelFor(request)
      if (placed === undefined) throw cancelled('no Discord channel maps to this session')

      const questions = request.questions ?? []
      const answers = []
      for (const [index, question] of questions.entries()) {
        answers.push(await askOne({
          channel: placed.channel,
          sessionId: placed.sessionId,
          question,
          position: index + 1,
          total: questions.length,
          signal: request.signal,
        }))
      }
      return { answers }
    })

    // The chain must survive a rejection, or one unanswered ask would strand
    // every later one behind a permanently rejected promise.
    queue = run.then(() => {}, () => {})
    return run
  }

  try {
    const dispose = service.registerProvider({ ask })
    logger.info('dsh-discord-bot: answering the harness\'s user questions in Discord')
    return dispose
  } catch (error) {
    // Someone owns the seam — in a web profile that is the browser UI, and it
    // is the surface a person is actually watching. Declining is correct.
    logger.warn('dsh-discord-bot: another user-questions provider is already registered (%s); questions stay where they are', described(error))
    return undefined
  }
}
