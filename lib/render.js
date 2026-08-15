import { AttachmentBuilder, EmbedBuilder } from 'discord.js'

/** Embed description ceiling Discord enforces; leave room for the tail note. */
const DESCRIPTION_BUDGET = 3800
/** Per-entry text budget, so one long tool result cannot eat a whole page. */
const ENTRY_BUDGET = 320

const COLOR_OK = 0x5865f2
const COLOR_WARN = 0xfaa61a

/** How each session-event type reads in a trajectory line. */
const TYPE_LABEL = {
  'user/message': '👤 user',
  'assistant/message': '🤖 assistant',
  'tool/call': '🔧 tool',
  'tool/result': '📄 result',
}

/**
 * Neutralize text taken from a session log before it enters a Discord message.
 * Session content is arbitrary user and model output: a stray fence would break
 * out of the code block, and an @everyone would ping the server.
 * @param {string} text - raw text from the session log.
 * @returns {string} text safe to embed.
 */
function sanitize(text) {
  return text.replaceAll('```', '`​``').replaceAll('@', '@​')
}

/**
 * Clip to a budget on a character boundary, marking that clipping happened.
 * @param {string} text - the text to clip.
 * @param {number} max - maximum characters to keep.
 * @returns {string} the clipped text.
 */
function clip(text, max) {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * A Discord relative timestamp, rendered in each viewer's own locale and zone.
 *
 * Accepts both shapes the harness uses: session events carry epoch
 * milliseconds, while a session header's `createdAt` is an ISO string. Feeding
 * a number to `Date.parse` yields NaN and Discord renders the literal
 * `<t:NaN:R>`, so the conversion belongs here rather than at each call site.
 *
 * @param {number | string | undefined} value - epoch ms or an ISO-8601 instant.
 * @returns {string} a `<t:…:R>` tag, or a plain marker when the input is unusable.
 */
function when(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return '_unknown_'
  return `<t:${Math.floor(ms / 1000)}:R>`
}

/**
 * Fit lines into an embed description, spilling the complete text to a file
 * attachment when it does not fit. Discord silently rejects an oversized embed,
 * so the overflow path is what keeps a long trajectory answerable at all.
 * @param {string[]} lines - rendered lines, in display order.
 * @param {object} options - fitting options.
 * @param {'head' | 'tail'} options.keep - which end survives clipping.
 * @param {string} options.filename - attachment name for the full text.
 * @returns {{description: string, files: AttachmentBuilder[]}} embed pieces.
 */
function fitOrAttach(lines, { keep, filename }) {
  const joined = lines.join('\n')
  if (joined.length <= DESCRIPTION_BUDGET) return { description: joined || '_nothing to show_', files: [] }

  const kept = []
  let used = 0
  const ordered = keep === 'tail' ? [...lines].reverse() : lines
  for (const line of ordered) {
    if (used + line.length + 1 > DESCRIPTION_BUDGET) break
    kept.push(line)
    used += line.length + 1
  }
  if (keep === 'tail') kept.reverse()

  const dropped = lines.length - kept.length
  const note = `\n_… ${dropped} more line(s) — full text attached as \`${filename}\`_`
  return {
    description: `${kept.join('\n')}${note}`,
    files: [new AttachmentBuilder(Buffer.from(joined, 'utf8'), { name: filename })],
  }
}

/**
 * Render the session list for one workspace.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the channel's workspace.
 * @param {object[]} sessions - summaries from `listWorkspaceSessions`.
 * @returns {object} an interaction reply payload.
 */
export function renderSessions(workspace, sessions) {
  if (sessions.length === 0) {
    return { embeds: [new EmbedBuilder().setColor(COLOR_WARN).setTitle(`📁 ${workspace.title}`).setDescription('_no sessions in this workspace yet_')] }
  }

  const total = sessions[0].total
  const lines = sessions.map((session) => {
    const flags = [session.live ? '🟢' : '⚪', session.hasParent ? '↳' : '', session.accounted ? '' : '·unlisted'].filter(Boolean).join('')
    const title = session.title === undefined ? '_untitled_' : clip(sanitize(session.title), 60)
    return `${flags} \`${session.short}\` ${title} · ${when(session.createdAt)}`
  })

  const { description, files } = fitOrAttach(lines, { keep: 'head', filename: 'sessions.txt' })
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(`📁 ${workspace.title}`)
    .setDescription(description)
    .setFooter({ text: `${sessions.length} of ${total} session(s) · ${workspace.path}` })

  return { embeds: [embed], files }
}

/**
 * Render a semantic trajectory: what was actually said and done, oldest-first.
 * @param {object} session - the resolved session summary.
 * @param {{entries: object[], total: number}} trajectory - from `readTrajectory`.
 * @returns {object} an interaction reply payload.
 */
export function renderTrajectory(session, trajectory) {
  const lines = trajectory.entries.map((entry) => {
    const label = TYPE_LABEL[entry.type] ?? `· ${entry.type}`
    const shadow = entry.surface === 'shadowed' ? ' ~compacted~' : ''
    const text = entry.text.length === 0 ? '_no text_' : clip(sanitize(entry.text), ENTRY_BUDGET)
    return `**${label}** \`#${entry.seq}\` ${when(entry.time)}${shadow}\n${text}`
  })

  const { description, files } = fitOrAttach(lines, { keep: 'tail', filename: `trace-${session.short}.txt` })
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(`🧭 ${session.title ?? session.short}`)
    .setDescription(description)
    .setFooter({ text: `last ${trajectory.entries.length} of ${trajectory.total} entries · session ${session.short}` })

  return { embeds: [embed], files }
}

/**
 * Render the structural event timeline plus a type histogram.
 * @param {object} session - the resolved session summary.
 * @param {{entries: object[], total: number, counts: [string, number][]}} timeline - from `readTimeline`.
 * @returns {object} an interaction reply payload.
 */
export function renderTimeline(session, timeline) {
  const lines = timeline.entries.map((entry) => `\`#${String(entry.seq).padStart(5)}\` ${entry.type} · ${when(entry.time)}${entry.surface === 'log-only' ? '' : ` · ${entry.surface}`}`)
  const { description, files } = fitOrAttach(lines, { keep: 'tail', filename: `timeline-${session.short}.txt` })

  const histogram = timeline.counts.slice(0, 8).map(([type, count]) => `\`${count}×\` ${type}`).join(' · ')
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(`⏱ ${session.title ?? session.short}`)
    .setDescription(description)
    .addFields({ name: 'event types', value: histogram || '_none_' })
    .setFooter({ text: `last ${timeline.entries.length} of ${timeline.total} events · session ${session.short}` })

  return { embeds: [embed], files }
}

/**
 * Render a subagent listing as an indented tree.
 * @param {object} session - the resolved parent session summary.
 * @param {object[]} entries - from `listSubagents`.
 * @param {boolean} deep - whether the listing walked descendants.
 * @returns {object} an interaction reply payload.
 */
export function renderSubagents(session, entries, deep) {
  if (entries.length === 0) {
    return {
      embeds: [new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle(`🧬 ${session.title ?? session.short}`)
        .setDescription(deep ? '_no subagents anywhere below this session_' : '_no direct subagents_')
        .setFooter({ text: `session ${session.short}` })],
    }
  }

  const lines = entries.map((entry) => {
    const indent = '  '.repeat(Math.max(0, (entry.depth ?? 1) - 1))
    if (entry.kind === 'diagnostic') return `${indent}⚠️ \`${entry.short}\` unreadable (${entry.reason})`

    const dot = entry.activity === 'running' ? '🟢' : '⚪'
    const label = entry.label === undefined ? '_unlabelled_' : clip(sanitize(entry.label), 70)
    const more = entry.hasChildren && !deep ? ' ▸' : ''
    return `${indent}${dot} \`${entry.short}\` **${entry.mode}** ${label}${more}`
  })

  const running = entries.filter((entry) => entry.activity === 'running').length
  const { description, files } = fitOrAttach(lines, { keep: 'head', filename: `subagents-${session.short}.txt` })
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(`🧬 ${session.title ?? session.short}`)
    .setDescription(description)
    .setFooter({ text: `${entries.length} ${deep ? 'descendant' : 'direct child'}(ren) · ${running} running · session ${session.short}` })

  return { embeds: [embed], files }
}

/**
 * Render a session's lineage: ancestry outward, then descendant trees.
 * @param {object} session - the resolved session summary.
 * @param {object} lineage - from `readLineage`.
 * @returns {object} an interaction reply payload.
 */
export function renderLineage(session, lineage) {
  const ancestors = lineage.ancestors.length === 0
    ? '_none — this is a root session_'
    : lineage.ancestors.map((record, index) => `${'  '.repeat(index)}↑ \`${record.short}\`${record.live ? ' 🟢' : ''}`).join('\n')

  const descendants = lineage.descendants.length === 0
    ? '_none_'
    : lineage.descendants.map((record) => `${'  '.repeat(record.depth - 1)}↳ \`${record.short}\`${record.live ? ' 🟢' : ''}`).join('\n')

  const embed = new EmbedBuilder()
    .setColor(lineage.complete ? COLOR_OK : COLOR_WARN)
    .setTitle(`🌳 ${session.title ?? session.short}`)
    .addFields(
      { name: 'ancestors', value: ancestors.slice(0, 1000) },
      { name: 'descendants', value: descendants.slice(0, 1000) },
    )
    .setFooter({
      text: lineage.complete
        ? `complete lineage · session ${session.short}`
        : `partial — parent ${lineage.unresolvedParentId} is outside the visible corpus`,
    })

  return { embeds: [embed] }
}

/**
 * Render the harness overview shown by `/dsh status`.
 * @param {object} overview - from `readOverview`.
 * @param {import('./workspaces.js').WorkspaceView[]} workspaces - mapped workspaces.
 * @param {object} meta - bot-side facts.
 * @param {string} meta.categoryName - the Discord category in use.
 * @param {number} meta.mapped - how many channels are currently mapped.
 * @returns {object} an interaction reply payload.
 */
export function renderStatus(overview, workspaces, meta) {
  const services = Object.entries(overview.services)
    .map(([name, mounted]) => `${mounted ? '✅' : '➖'} \`${name}\``)
    .join('\n')

  const list = workspaces.length === 0
    ? '_none_'
    : workspaces.slice(0, 20).map((workspace) => `• **${clip(sanitize(workspace.title), 40)}** — ${workspace.sessionIds.length} session(s)${workspace.synthetic ? ' _(from cwd)_' : ''}`).join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('🛰 dsh ↔ Discord')
    .setDescription(`Reaching this harness needs no inbound port: the bot dials out over the Discord gateway.`)
    .addFields(
      { name: 'harness services', value: services, inline: true },
      { name: 'sessions', value: `${overview.sessions.total} total\n${overview.sessions.live} live`, inline: true },
      { name: `workspaces → #${meta.categoryName}`, value: list },
    )
    .setFooter({ text: `${meta.mapped} channel(s) mapped` })

  return { embeds: [embed] }
}

/**
 * Render the current default model and the catalog around it.
 * @param {object} selection - from `readModelSelection`.
 * @returns {object} an interaction reply payload.
 */
export function renderModel(selection) {
  const { current, models, providers } = selection

  const list = models.length === 0
    ? '_this provider advertises no catalog; you can still switch by exact id_'
    : models
      .map((model) => `${model.id === current.model ? '▸ **' : '  '}\`${model.id}\`${model.id === current.model ? '**' : ''} ${clip(sanitize(model.description ?? model.name), 60)}`)
      .join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('🧠 default model')
    .setDescription(`New sessions start on **${current.provider}/${current.model}**${current.reasoningEffort === undefined ? '' : ` · effort \`${current.reasoningEffort}\``}.\nSessions already running keep the model they were created with.`)
    .addFields({ name: `models on ${current.provider}`, value: list.slice(0, 1000) })
    .setFooter({ text: `providers: ${providers.map((provider) => provider.id).join(', ') || 'none'}` })

  return { embeds: [embed] }
}

/**
 * Render the outcome of a model switch.
 * @param {object} change - from `switchModel`.
 * @returns {object} an interaction reply payload.
 */
export function renderModelSwitched(change) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('🧠 default model changed')
    .setDescription(`\`${change.before.provider}/${change.before.model}\` → **${change.after.provider}/${change.after.model}**`)
    .setFooter({ text: 'applies to sessions created from now on; running sessions are unchanged' })

  return { embeds: [embed] }
}

/**
 * Render a newly registered workspace.
 * @param {object} workspace - from `createWorkspace`.
 * @param {string | undefined} channelName - the channel created for it, if any.
 * @returns {object} an interaction reply payload.
 */
export function renderWorkspaceCreated(workspace, channelName) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(workspace.alreadyRegistered ? '📁 workspace already registered' : '📁 workspace registered')
    .setDescription(`**${clip(sanitize(workspace.title), 60)}**\n\`${workspace.path}\``)
    .addFields(
      { name: 'sessions', value: String(workspace.sessions), inline: true },
      { name: 'channel', value: channelName === undefined ? '_not created — check the bot\'s permissions_' : `#${channelName}`, inline: true },
    )

  return { embeds: [embed] }
}

/**
 * Render a failure as a reply the operator can act on.
 * @param {unknown} error - the thrown value.
 * @returns {object} an interaction reply payload.
 */
export function renderError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('⚠️ query failed').setDescription(clip(sanitize(message), 1500))],
  }
}
