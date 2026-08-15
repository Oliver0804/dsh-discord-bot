import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from 'discord.js'

import { isAuthorized } from './config.js'
import { ambientTranslator } from './i18n.js'
import { shortId } from './queries.js'
import { described } from './util.js'

/** How long an approval card waits before handing the question back. */
const DECISION_TIMEOUT_MS = 120_000

/**
 * Answer dsh's approval questions with a Discord card.
 *
 * `approval/request` is a waterfall: an answerer either returns an outcome or
 * calls `next()` to pass the question along. Three rules follow from that, and
 * each one is a safety property rather than a preference.
 *
 * **Which sessions are answered is a deployment choice.** By default only runs
 * this bot started: a session the user is driving from the web UI keeps being
 * answered there, and silently intercepting its questions would move a prompt
 * they are watching for onto a surface they are not. `mirrorApprovals` opts
 * into the other posture — every session's questions come to Discord — which is
 * what makes a phone enough to unblock work started at the machine, at the cost
 * that a web-side user sees no prompt until this card times out.
 *
 * **A timeout delegates instead of deciding.** Returning `rejected` because
 * nobody clicked would make this bot the author of a decision it never took;
 * `next()` lets dsh's own fail-closed path — or the web UI — run.
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
 * @param {object} args.resolver - the shared channel resolver, for foreign sessions.
 * @returns {() => void} disposer removing the answerer.
 */
export function installApprovalAnswerer({ ctx, config, logger, client, runs, resolver }) {
  // No interacting human to follow, so `auto` falls back to the guild's own
  // preferred locale rather than English — see `ambientTranslator`.
  const t = ambientTranslator(config, () => client()?.guilds?.cache?.get(config.guildId)?.preferredLocale)

  return ctx.on('approval/request', async (req, next) => {
    const sessionId = String(req.agent?.session?.id ?? '')
    const run = runs.get(sessionId)

    // A foreign session — web UI, tui, cron — is only answered here when the
    // operator asked for it. Subagent questions are not filtered by
    // `mirrorSubagents`: that setting controls how much conversation reaches a
    // channel, and dropping a question is not a volume decision.
    let channelId = run?.channelId
    if (channelId === undefined) {
      if (!config.mirrorApprovals) return next()
      const located = await Promise.resolve(resolver?.locate(sessionId)).catch(() => undefined) ?? {}
      if (located.channelId === undefined) return next()
      channelId = located.channelId
    }

    const discord = client()
    if (discord === undefined) return next()

    let channel
    try {
      channel = await discord.channels.fetch(channelId)
    } catch {
      return next()
    }
    if (channel === null || !channel.isTextBased()) return next()

    const embed = new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle(t('approval.title'))
      .setDescription(`${t('approval.body', { tool: req.toolName })}${req.reason === undefined ? '' : `\n\n${String(req.reason).slice(0, 1500)}`}`)
      .setFooter({ text: t(run === undefined ? 'approval.footerElsewhere' : 'approval.footer', { short: shortId(sessionId), minutes: Math.round(DECISION_TIMEOUT_MS / 60_000) }) })

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dsh-approve').setLabel(t('approval.allow')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dsh-deny').setLabel(t('approval.deny')).setStyle(ButtonStyle.Danger),
    )

    let card
    try {
      card = await channel.send({ embeds: [embed], components: [row] })
    } catch (error) {
      logger.warn('dsh-discord-bot: could not post the approval card: %s', described(error))
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
          await interaction.reply({ content: t('approval.notAllowed'), flags: MessageFlags.Ephemeral }).catch(() => {})
          return
        }

        const allowed = interaction.customId === 'dsh-approve'
        await interaction.update({
          embeds: [EmbedBuilder.from(embed)
            .setColor(allowed ? 0x57f287 : 0xed4245)
            .setFooter({ text: t(allowed ? 'approval.allowed' : 'approval.denied', { user: interaction.user.tag }) })],
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
        embeds: [EmbedBuilder.from(embed).setColor(0x99aab5).setFooter({ text: t('approval.timedOut') })],
        components: [],
      }).catch(() => {})
      return next()
    }

    return outcome
  })
}
