import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from 'discord.js'

import { isAuthorized } from './config.js'

/** How long an approval card waits before handing the question back. */
const DECISION_TIMEOUT_MS = 120_000

/**
 * Answer dsh's approval questions with a Discord card.
 *
 * `approval/request` is a waterfall: an answerer either returns an outcome or
 * calls `next()` to pass the question along. Three rules follow from that, and
 * each one is a safety property rather than a preference.
 *
 * **Only our own runs are answered.** A session the user is driving from the
 * web UI must keep being answered there; silently intercepting its questions
 * would move a prompt the user is watching for onto a surface they are not.
 *
 * **A timeout delegates instead of deciding.** Returning `rejected` because
 * nobody clicked would make this bot the author of a decision it never took;
 * `next()` lets dsh's own fail-closed path run.
 *
 * **The button is the last gate before remote execution**, so the clicker is
 * checked against the same allowlist as the command that started the run —
 * being able to see the channel is not the same as being able to approve.
 *
 * @param {object} args - answerer dependencies.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.logger - the plugin logger.
 * @param {() => import('discord.js').Client | undefined} args.client - the live client.
 * @param {Map<string, {channelId: string}>} args.runs - sessions this plugin is driving.
 * @returns {() => void} disposer removing the answerer.
 */
export function installApprovalAnswerer({ ctx, config, logger, client, runs }) {
  return ctx.on('approval/request', async (req, next) => {
    const sessionId = String(req.agent?.session?.id ?? '')
    const run = runs.get(sessionId)
    if (run === undefined) return next()

    const discord = client()
    if (discord === undefined) return next()

    let channel
    try {
      channel = await discord.channels.fetch(run.channelId)
    } catch {
      return next()
    }
    if (channel === null || !channel.isTextBased()) return next()

    const embed = new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle('🔐 approval needed')
      .setDescription(`dsh wants to run **${req.toolName}**${req.reason === undefined ? '' : `\n\n${String(req.reason).slice(0, 1500)}`}`)
      .setFooter({ text: `session ${sessionId.replace(/^session-/, '').slice(0, 8)} · expires in 2 min` })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dsh-approve').setLabel('Allow once').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dsh-deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
    )

    let card
    try {
      card = await channel.send({ embeds: [embed], components: [row] })
    } catch (error) {
      logger.warn('dsh-discord-bot: could not post the approval card: %s', error instanceof Error ? error.message : error)
      return next()
    }

    const outcome = await new Promise((resolve) => {
      const collector = card.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: DECISION_TIMEOUT_MS,
      })

      // The asker can withdraw the question; stop waiting and let it settle.
      const onAbort = () => collector.stop('cancelled')
      req.signal?.addEventListener('abort', onAbort, { once: true })

      collector.on('collect', async (interaction) => {
        if (!isAuthorized(config, interaction.user.id, interaction.guild?.ownerId)) {
          await interaction.reply({ content: '⛔ You are not allowed to approve dsh actions.', flags: MessageFlags.Ephemeral }).catch(() => {})
          return
        }

        const allowed = interaction.customId === 'dsh-approve'
        await interaction.update({
          embeds: [EmbedBuilder.from(embed)
            .setColor(allowed ? 0x57f287 : 0xed4245)
            .setFooter({ text: `${allowed ? 'allowed once' : 'denied'} by ${interaction.user.tag}` })],
          components: [],
        }).catch(() => {})

        collector.stop('decided')
        resolve(allowed ? 'allowed-once' : 'rejected')
      })

      collector.on('end', (_collected, reason) => {
        req.signal?.removeEventListener('abort', onAbort)
        if (reason === 'decided') return
        resolve(reason === 'cancelled' ? 'cancelled' : undefined)
      })
    })

    if (outcome === undefined) {
      // Nobody answered in time. Retire the card and hand the question on
      // rather than deciding it here.
      await card.edit({
        embeds: [EmbedBuilder.from(embed).setColor(0x99aab5).setFooter({ text: 'no answer in time — handed back to dsh' })],
        components: [],
      }).catch(() => {})
      return next()
    }

    return outcome
  })
}
