import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'

/**
 * Buttons on a running turn's card.
 *
 * The card a turn reports into is the one place a phone user already has open
 * while the harness works. Rather than making them type `/dsh trace` or
 * `/dsh subagents` (or hunt for `/dsh stop`) while watching, the card carries
 * the views a watcher actually reaches for: trajectory, raw timeline,
 * subagents, todos, and the full export.
 *
 * When execution is enabled a second row adds the two things that *cause*
 * work: **Steer** (open a modal and deliver a message at the turn's next step
 * boundary) and **Stop** (two-step confirm, so a phone in a pocket cannot
 * interrupt work by accident).
 *
 * The buttons are stateless, exactly like the menu card: the session's short
 * id and the action are encoded in the component's `customId`, so a card left
 * in scrollback still works after a restart.
 */

/** Prefix marking a component as a running-card action, distinct from menus and approvals. */
export const ACTIONS_PREFIX = 'dsh:act'

/** Whether an interaction belongs to a running-card action. */
export function isActionInteraction(interaction) {
  return typeof interaction.customId === 'string' && interaction.customId.startsWith(`${ACTIONS_PREFIX}:`)
}

/**
 * Decode a running-card button id.
 * @param {string} customId - the clicked component's id.
 * @returns {{short: string | undefined, action: string | undefined}} the session
 *   short id and which button was pressed.
 */
export function decodeAction(customId) {
  const [, , short, action] = String(customId ?? '').split(':')
  return { short, action }
}

/**
 * The button rows attached to a running turn's card.
 *
 * Discord allows five buttons per row and five rows per message, so the read
 * surface gets its own row and the execution surface another. The stop button
 * is only offered when `allowRun` is on; `confirming` replaces the execution
 * row with Confirm/Cancel so a stray tap cannot interrupt work.
 *
 * A finished turn keeps only the read row. Steering and stopping both act on a
 * turn in flight — offering them on a card that already says ✅ promises
 * something the harness will refuse, and the refusal would arrive as an error
 * for doing what the card invited.
 *
 * @param {string} short - the session's short id.
 * @param {object} options - button options.
 * @param {boolean} [options.allowRun] - whether execution buttons are offered.
 * @param {boolean} [options.confirming] - whether stop is awaiting confirmation.
 * @param {boolean} [options.done] - whether the turn has finished.
 * @param {(key: string, params?: object) => string} t - translator for labels.
 * @returns {import('discord.js').ActionRowBuilder[]} the component rows.
 */
export function actionButtons(short, { allowRun = false, confirming = false, done = false, t }) {
  const id = (action) => `${ACTIONS_PREFIX}:${short}:${action}`

  const readRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id('trace')).setLabel(t('action.trace')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('timeline')).setLabel(t('action.timeline')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('subagents')).setLabel(t('action.subagents')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('todos')).setLabel(t('action.todos')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('export')).setLabel(t('action.export')).setStyle(ButtonStyle.Secondary),
  )

  if (!allowRun || done) return [readRow]

  if (confirming) {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(id('confirm')).setLabel(t('action.confirmStop')).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(id('cancel')).setLabel(t('action.cancelStop')).setStyle(ButtonStyle.Secondary),
    )
    return [readRow, confirmRow]
  }

  const workRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id('steer')).setLabel(t('action.steer')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(id('stop')).setLabel(t('action.stop')).setStyle(ButtonStyle.Danger),
  )
  return [readRow, workRow]
}
