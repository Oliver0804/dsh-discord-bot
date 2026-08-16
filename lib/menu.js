import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js'

import * as render from './render.js'
import { TranslatableError } from './i18n.js'
import { listWorkspaces } from './workspaces.js'
import {
  listSubagents,
  listWorkspaceSessions,
  readAgentPresets,
  readLineage,
  readModelSelection,
  readOverview,
  readPermissionPresets,
  readAgentContext,
  readSessionStats,
  readTimeline,
  readTodos,
  readTrajectory,
  switchAgentPreset,
  switchModel,
  switchPermissionPreset,
} from './queries.js'

/**
 * One card that stands in for the whole command surface.
 *
 * Slash commands are precise and they are also a lot of typing on a phone —
 * which is the machine this bot exists to be used from. `/dsh menu` posts a
 * card whose dropdowns cover the same ground: pick what to look at, pick which
 * session, switch the model, the agent preset, or the permissions, without
 * typing anything again.
 *
 * The card holds no server-side state. Everything it needs — the view being
 * shown, the session selected, which settings picker is open — is encoded into
 * the `customId` of its own components and read back on the next click. A bot
 * restart therefore costs nothing: a card posted yesterday still works, because
 * the message *is* the state. Nothing here is remembered, so nothing here can
 * go stale or leak between channels.
 *
 * Discord allows five component rows per message, which is exactly the budget:
 * view, session, settings picker, the open picker's options, and the buttons.
 */

/** Prefix marking a component as this menu's, distinct from approval buttons. */
export const MENU_PREFIX = 'dsh:menu'
/** Discord's ceiling on select options. */
const OPTION_LIMIT = 25
/** Placeholder for an unset state slot inside a customId. */
const UNSET = '-'

/** The views the card can show, in the order the dropdown lists them. */
const VIEWS = ['sessions', 'trace', 'timeline', 'todos', 'subagents', 'lineage', 'context', 'status']
/** The settings the card can change. */
const SETTINGS = ['model', 'preset', 'permission']

/**
 * Whether an interaction belongs to this menu.
 * @param {object} interaction - any Discord component interaction.
 * @returns {boolean} true when this module owns it.
 */
export function isMenuInteraction(interaction) {
  return typeof interaction.customId === 'string' && interaction.customId.startsWith(`${MENU_PREFIX}:`)
}

/**
 * Read the card's state out of a component id.
 * @param {string} customId - the clicked component's id.
 * @returns {{kind: string, state: object}} which control was used, and the card state.
 */
export function decodeMenu(customId) {
  const [, , kind = '', session = UNSET, setting = UNSET, view = UNSET] = customId.split(':')
  return {
    kind,
    state: {
      session: session === UNSET ? undefined : session,
      setting: setting === UNSET ? undefined : setting,
      view: view === UNSET ? 'sessions' : view,
    },
  }
}

/**
 * Write the card's state into a component id.
 * @param {string} kind - the control this id belongs to.
 * @param {object} state - the card state to carry forward.
 * @returns {string} the encoded id, within Discord's 100-character limit.
 */
export function encodeMenu(kind, state) {
  return [MENU_PREFIX, kind, state.session ?? UNSET, state.setting ?? UNSET, state.view ?? 'sessions'].join(':')
}

/**
 * Clip a label to Discord's per-option limit without cutting mid-marker.
 * @param {string} value - the raw label.
 * @param {number} max - the ceiling.
 * @returns {string} a label Discord will accept.
 */
const label = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? (text.length === 0 ? '—' : text) : `${text.slice(0, max - 1)}…`
}

/**
 * An option's value — the string sent back on selection — which must survive
 * verbatim. A label may be clipped; a value may not, because a clipped id would
 * be applied as if it were the real one, so an over-long id loses its row
 * instead. Selecting it by name with the slash command still works.
 * @param {string} raw - the identifier this option stands for.
 * @returns {string | undefined} the value, or undefined when it cannot be one.
 */
const optionValue = (raw) => {
  const text = String(raw ?? '').trim()
  return text.length > 0 && text.length <= 100 ? text : undefined
}

/**
 * Render the content half of the card: whichever view is selected, using the
 * same renderers the slash commands use, so the card and the commands cannot
 * drift apart.
 *
 * @param {object} args - view inputs.
 * @returns {Promise<object>} an embed payload.
 */
async function renderView({ ctx, config, workspace, sessions, state, mapped, t }) {
  const view = state.view ?? 'sessions'

  if (view === 'status') {
    const [overview, workspaces] = await Promise.all([readOverview(ctx), listWorkspaces(ctx)])
    return render.renderStatus(overview, workspaces, { categoryName: config.categoryName, mapped }, t)
  }

  if (view === 'sessions') return render.renderSessions(workspace, sessions, t)

  const target = sessions.find((entry) => entry.short === state.session) ?? sessions[0]
  if (target === undefined) return render.renderSessions(workspace, sessions, t)

  if (view === 'trace') {
    const [trajectory, stats] = await Promise.all([
      readTrajectory(ctx, target.id, { limit: config.traceLimit }),
      readSessionStats(ctx, target.id),
    ])
    return render.renderTrajectory(target, trajectory, t, stats)
  }

  if (view === 'timeline') {
    const [timeline, stats] = await Promise.all([
      readTimeline(ctx, target.id, { limit: config.traceLimit }),
      readSessionStats(ctx, target.id),
    ])
    return render.renderTimeline(target, timeline, t, stats)
  }

  if (view === 'todos') {
    // Both of these need a live agent — a cold session carries no todo
    // payloads and has no composition to describe. Falling back to the session
    // list keeps the card usable instead of turning it into an error.
    const todos = readTodos(ctx, target.id)
    if (todos === undefined) return render.renderSessions(workspace, sessions, t)
    return render.renderTodos(target, todos, t)
  }

  if (view === 'context') {
    try {
      return render.renderAgentContext(await readAgentContext(ctx, target.id), t)
    } catch {
      return render.renderSessions(workspace, sessions, t)
    }
  }

  if (view === 'subagents') {
    return render.renderSubagents(target, await listSubagents(ctx, target.id, { deep: false }), false, t)
  }

  return render.renderLineage(target, await readLineage(ctx, target.id), t)
}

/**
 * The session a settings change made on this card should follow: the one the
 * card is showing, when it is actually running.
 *
 * A cold session has no agent to retarget, and a model switch aimed at one
 * would be refused. Resolving to `undefined` there moves the default instead,
 * which is the whole of what the switch can honestly do.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object[]} sessions - the workspace's sessions, newest first.
 * @param {string | undefined} short - the card's selected session.
 * @returns {string | undefined} the session id to follow, when one is live.
 */
function liveTarget(ctx, sessions, short) {
  const known = sessions.find((entry) => entry.short === short) ?? sessions[0]
  if (known === undefined) return undefined
  return ctx.get('agents')?.get(known.id) === undefined ? undefined : known.id
}

/**
 * The options for whichever settings picker is open, and the value currently in
 * force. A profile that does not mount the service behind a picker yields
 * nothing, and the row is left out rather than shown broken.
 *
 * @param {object} args - picker inputs.
 * @returns {Promise<{options: object[], current: string | undefined} | undefined>} the picker, when available.
 */
async function settingOptions({ ctx, setting, sessionId, t }) {
  try {
    if (setting === 'model') {
      const selection = await readModelSelection(ctx, sessionId)
      return {
        // The session's own model when it is running, because that is what the
        // picker changes — marking the default there would show the wrong row
        // as current on every session that has been switched since it started.
        current: (selection.session?.current ?? selection.current).model,
        options: selection.models
          .map((model) => ({
            label: label(model.id),
            value: optionValue(model.id),
            description: label(model.description ?? model.name, 100),
          }))
          .filter((option) => option.value !== undefined)
          .slice(0, OPTION_LIMIT),
      }
    }

    if (setting === 'preset') {
      const roster = await readAgentPresets(ctx)
      return {
        current: roster.current,
        options: roster.presets
          .filter((preset) => preset.broken === undefined)
          .map((preset) => ({
            label: label(preset.name ?? preset.id),
            value: optionValue(preset.id),
            description: label(preset.description ?? preset.id, 100),
          }))
          .filter((option) => option.value !== undefined)
          .slice(0, OPTION_LIMIT),
      }
    }

    const permissions = await readPermissionPresets(ctx, sessionId)
    return {
      // The session's own permission when it is running, for the same reason
      // the model picker marks the session's model: that is the row a click
      // would change, and the default is not.
      current: permissions.session?.current ?? permissions.default,
      options: permissions.options
        .map((option) => ({
          label: label(option.name),
          value: optionValue(option.id),
          description: label(option.description ?? [option.sandbox, option.approval].filter(Boolean).join(' · '), 100),
        }))
        .filter((option) => option.value !== undefined)
        .slice(0, OPTION_LIMIT),
    }
  } catch {
    // A missing service is a missing row, not a broken card.
    return undefined
  }
}

/**
 * Build the whole card: content, then the controls that change it.
 *
 * @param {object} args - card inputs.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.workspace - the channel's workspace.
 * @param {object} args.state - `{view, session, setting}`.
 * @param {object[]} [args.notices] - embeds to append under the content.
 * @param {number} [args.mapped] - how many channels are mapped, for the status view.
 * @param {(key: string, params?: object) => string} args.t - translator.
 * @returns {Promise<object>} a Discord message payload.
 */
export async function buildMenu({ ctx, config, workspace, state, notices = [], mapped = 0, t }) {
  const sessions = await listWorkspaceSessions(ctx, workspace, OPTION_LIMIT)

  // The selected session must exist; a card whose stored id was since deleted
  // falls back to the newest rather than rendering an error the user cannot fix.
  const known = sessions.find((entry) => entry.short === state.session)
  const current = { ...state, session: known?.short ?? sessions[0]?.short }

  const content = await renderView({ ctx, config, workspace, sessions, state: current, mapped, t })

  const viewRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(encodeMenu('view', current))
      .setPlaceholder(t('menu.pickView'))
      .addOptions(VIEWS.map((view) => ({
        label: label(t(`menu.view.${view}`)),
        value: view,
        default: view === (current.view ?? 'sessions'),
      }))),
  )

  const sessionRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(encodeMenu('session', current))
      .setPlaceholder(t('menu.pickSession'))
      .setDisabled(sessions.length === 0)
      .addOptions(sessions.length === 0
        ? [{ label: label(t('menu.noSessions')), value: 'none' }]
        : sessions.slice(0, OPTION_LIMIT).map((entry) => ({
            label: label(`${entry.live ? '🟢 ' : ''}${entry.short} · ${entry.title ?? t('sessions.untitled')}`),
            value: entry.short,
            default: entry.short === current.session,
          }))),
  )

  const settingRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(encodeMenu('setting', current))
      .setPlaceholder(t('menu.pickSetting'))
      .addOptions(SETTINGS.map((setting) => ({
        label: label(t(`menu.setting.${setting}`)),
        value: setting,
        default: setting === current.setting,
      }))),
  )

  const rows = [viewRow, sessionRow, settingRow]

  if (current.setting !== undefined) {
    // Marked against the session only when the picker can actually move it;
    // otherwise the row shown as current is not the row a click would change.
    const target = config.allowRun ? liveTarget(ctx, sessions, current.session) : undefined
    const picker = await settingOptions({ ctx, setting: current.setting, sessionId: target, t })
    if (picker !== undefined && picker.options.length > 0) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(encodeMenu(`apply-${current.setting}`, current))
          .setPlaceholder(t('menu.applyTo', { setting: t(`menu.setting.${current.setting}`) }))
          // Reading the roster is always allowed; applying one is the same
          // decision `/dsh preset` and `/dsh permission` gate on `allowRun`.
          .setDisabled(!config.allowRun && current.setting !== 'model')
          .addOptions(picker.options.map((option) => ({
            ...option,
            default: option.value === picker.current,
          }))),
      ))
    }
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeMenu('search', current))
      .setLabel(t('menu.search'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeMenu('sync', current))
      .setLabel(t('menu.sync'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeMenu('refresh', current))
      .setLabel(t('menu.refresh'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeMenu('close', current))
      .setLabel(t('menu.close'))
      .setStyle(ButtonStyle.Secondary),
  ))

  return {
    ...content,
    embeds: [...(content.embeds ?? []), ...notices].slice(0, 10),
    components: rows,
  }
}

/**
 * Handle one click on the card: apply what it means, then rebuild the card so
 * the message always shows the state it just moved to.
 *
 * @param {object} args - handler inputs.
 * @param {object} args.interaction - the component interaction.
 * @param {object} args.ctx - the plugin's Cordis context.
 * @param {object} args.config - the validated plugin config.
 * @param {object} args.workspace - the channel's workspace.
 * @param {(key: string, params?: object) => string} args.t - translator.
 * @returns {Promise<object | undefined>} the payload to write back, or undefined
 *   when the card removed itself.
 */
export async function applyMenu({ interaction, ctx, config, workspace, mapped = 0, t }) {
  const { kind, state } = decodeMenu(interaction.customId)
  const value = interaction.values?.[0]
  const notices = []

  if (kind === 'close') return { closed: true }

  if (kind === 'view') state.view = VIEWS.includes(value) ? value : 'sessions'
  else if (kind === 'session') state.session = value === 'none' ? undefined : value
  else if (kind === 'setting') state.setting = SETTINGS.includes(value) ? value : undefined
  else if (kind.startsWith('apply-')) {
    const setting = kind.slice('apply-'.length)
    // Same gate as the slash commands: what a later turn may do is not a read.
    // The model switch is the one that stays open, because moving the default
    // changes nothing that is already running — but only that half of it does.
    if (!config.allowRun && setting !== 'model') throw new TranslatableError('error.writeDisabled')

    // The card is a session view, so a switch follows the session it is showing
    // — the same thing the harness's own pickers do. Ungated (only `model` gets
    // this far), the card moves the default and leaves the session alone; and
    // an agent preset cannot follow a session at all, so it never asks for one.
    // Titles are not needed to pick a target and folding one opens every cold
    // session's log, so the listing goes without them.
    const target = config.allowRun && setting !== 'preset'
      ? liveTarget(ctx, await listWorkspaceSessions(ctx, workspace, OPTION_LIMIT, { titles: false }), state.session)
      : undefined

    if (setting === 'model') notices.push(...render.renderModelSwitched(await switchModel(ctx, value, target), t).embeds)
    else if (setting === 'preset') notices.push(...render.renderPresetSwitched(await switchAgentPreset(ctx, value), t).embeds)
    else notices.push(...render.renderPermissionSwitched(await switchPermissionPreset(ctx, value, target, { andDefault: true }), t).embeds)
  }

  return buildMenu({ ctx, config, workspace, state, notices, mapped, t })
}

/**
 * The card as first posted, before anyone has touched it.
 * @param {object} args - the same inputs {@link buildMenu} takes.
 * @returns {Promise<object>} a Discord message payload.
 */
export function openMenu({ ctx, config, workspace, mapped = 0, t }) {
  return buildMenu({ ctx, config, workspace, state: { view: 'sessions' }, mapped, t })
}

/**
 * The card, once closed: the controls are gone and the message says why, so a
 * stale card in scrollback cannot be clicked back to life.
 * @param {(key: string, params?: object) => string} t - translator.
 * @returns {object} a Discord message payload.
 */
export function closedMenu(t) {
  return {
    embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription(t('menu.closed'))],
    components: [],
    files: [],
  }
}
