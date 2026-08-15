import { randomUUID } from 'node:crypto'

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

import { isAuthorized } from './config.js'
import { ambientTranslator } from './i18n.js'
import { shortId } from './queries.js'
import { described } from './util.js'

/**
 * Modal answers waiting on the person who opened them.
 *
 * Discord's modal submit arrives as a separate interaction type, not a message
 * component the card can collect. The card's "custom answer" button stores a
 * resolver here under the modal's id, and the router forwards any
 * `dsh:question:*` modal submit to {@link answerQuestionModal}. A resolver is
 * removed when answered, timed out, or aborted, so a stale modal submit cannot
 * resolve a question that was already withdrawn.
 * @type {Map<string, {resolve: Function, reject: Function, card: object, embed: object}>}
 */
const modalResolvers = new Map()

/** Prefix for question-modal custom ids. */
export const QUESTION_MODAL_PREFIX = 'dsh:question'

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
    const modalId = `${QUESTION_MODAL_PREFIX}:${randomUUID()}`

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(t('question.title', { position, total }))
      .setDescription(`**${String(question.question).slice(0, 1000)}**${question.detail === undefined ? '' : `\n\n${String(question.detail).slice(0, 2000)}`}`)
      .setFooter({ text: t('question.footer', { short: shortId(sessionId), minutes: Math.round(ANSWER_TIMEOUT_MS / 60_000) }) })

    const rows = []
    if (options.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`dsh-question-${position}`)
        .setPlaceholder(t('question.pick'))
        .addOptions(options.map((option, index) => ({
          label: String(option.label).slice(0, 100),
          value: String(index),
          description: option.description === undefined ? undefined : String(option.description).slice(0, 100),
        })))
      if (question.multiSelect === true) select.setMinValues(1).setMaxValues(options.length)
      rows.push(new ActionRowBuilder().addComponents(select))
    }

    // Discord can offer a menu, but a person may also want to type an answer.
    // The modal is the only way to collect free text, and it must be opened
    // from an interaction the user started — this button is that interaction.
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dsh-question-custom-${position}`)
        .setLabel(t('question.custom'))
        .setStyle(ButtonStyle.Secondary),
    ))

    const card = await channel.send({ embeds: [embed], components: rows })

    const chosen = await new Promise((resolve, reject) => {
      const collector = card.createMessageComponentCollector({
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

        // The custom-answer button opens the modal and parks this promise
        // until the modal submit arrives through the router.
        if (interaction.isButton?.() === true && interaction.customId === `dsh-question-custom-${position}`) {
          const pending = {
            resolve: (text) => {
              modalResolvers.delete(modalId)
              collector.stop('answered')
              resolve([text])
            },
            reject: (error) => {
              modalResolvers.delete(modalId)
              collector.stop('aborted')
              reject(error)
            },
            card,
            embed,
          }
          modalResolvers.set(modalId, pending)

          await interaction.showModal(new ModalBuilder()
            .setCustomId(modalId)
            .setTitle(t('modal.answerTitle'))
            .addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('answer')
                .setLabel(t('modal.answerLabel'))
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(t('modal.answerPlaceholder'))
                .setMaxLength(2000)
                .setRequired(true),
            )))
          return
        }

        if (interaction.isStringSelectMenu?.() === true) {
          const labels = interaction.values.map((value) => options[Number(value)]?.label).filter((label) => label !== undefined)
          await interaction.update({
            embeds: [EmbedBuilder.from(embed).setColor(0x57f287).setFooter({ text: t('question.answered', { user: interaction.user.tag }) })],
            components: [],
          }).catch(() => {})

          modalResolvers.delete(modalId)
          collector.stop('answered')
          resolve(labels)
        }
      })

      collector.on('end', (_collected, reason) => {
        signal?.removeEventListener('abort', onAbort)
        modalResolvers.delete(modalId)
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

/**
 * Resolve one question answered through a modal.
 *
 * The router forwards every `dsh:question:*` modal submit here. The modal id is
 * the key into {@link modalResolvers}; a stale submit (question already
 * answered, withdrawn, or timed out) is acknowledged and dropped rather than
 * resolving a promise nobody is waiting on.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction - the modal submit.
 * @param {(key: string, params?: object) => string} t - translator for the reply.
 * @returns {Promise<void>} resolution once the answer is accepted.
 */
export async function answerQuestionModal(interaction, t) {
  const id = String(interaction.customId ?? '')
  const pending = modalResolvers.get(id)
  if (pending === undefined) {
    await interaction.reply({ content: 'This question is no longer waiting for an answer.', flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }

  const text = interaction.fields.getTextInputValue('answer')
  modalResolvers.delete(id)
  void pending.card.edit({
    embeds: [EmbedBuilder.from(pending.embed).setColor(0x57f287).setFooter({ text: t('question.answered', { user: interaction.user.tag }) })],
    components: [],
  }).catch(() => {})
  pending.resolve(text)
  await interaction.reply({ content: `✅ ${t('question.answered', { user: interaction.user.tag })}`, flags: MessageFlags.Ephemeral }).catch(() => {})
}
