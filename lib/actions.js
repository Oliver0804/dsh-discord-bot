import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'

/**
 * Buttons on a running turn's card.
 *
 * The card a turn reports into is the one place a phone user already has open
 * while the harness works. Rather than making them type `/dsh trace` or
 * `/dsh subagents` (or hunt for `/dsh stop`) while watching, the card carries
 * the three things a watcher actually reaches for: the trajectory, the
 * subagent tree, and — when execution is enabled at all — an interrupt.
 *
 * The buttons are stateless, exactly like the menu card: the session's short
 * id and the action are encoded in the component's `customId`, so a card left
 * in scrollback still works after a restart. The stop button is only rendered
 * when `allowRun` is on, because interrupting work is the same class of effect
 * that flag gates everywhere else.
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
 * The button row attached to a running turn's card.
 * @param {string} short - the session's short id.
 * @param {object} options - button options.
 * @param {boolean} [options.allowRun] - whether the stop button is offered.
 * @param {(key: string, params?: object) => string} t - translator for labels.
 * @returns {import('discord.js').ActionRowBuilder} the component row.
 */
export function actionButtons(short, { allowRun = false, t }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ACTIONS_PREFIX}:${short}:trace`)
      .setLabel(t('action.trace'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${ACTIONS_PREFIX}:${short}:subagents`)
      .setLabel(t('action.subagents'))
      .setStyle(ButtonStyle.Secondary),
  )

  if (allowRun) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${ACTIONS_PREFIX}:${short}:stop`)
        .setLabel(t('action.stop'))
        .setStyle(ButtonStyle.Danger),
    )
  }

  return row
}
