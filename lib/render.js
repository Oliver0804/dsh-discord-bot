import { AttachmentBuilder, EmbedBuilder } from 'discord.js'

import { COMMANDS, translator } from './i18n.js'
import { TYPE_LABEL } from './queries.js'

/** Fallback translator, so a caller that passes none still gets English. */
const EN = translator('en')

/** Embed description ceiling Discord enforces; leave room for the tail note. */
const DESCRIPTION_BUDGET = 3800
/** Per-entry text budget, so one long tool result cannot eat a whole page. */
const ENTRY_BUDGET = 320

const COLOR_OK = 0x5865f2
const COLOR_WARN = 0xfaa61a

/**
 * Compact a duration the way a stats strip should read: whole seconds when it
 * is seconds, one decimal when the tenths are the interesting part.
 * @param {number} ms - milliseconds.
 * @returns {string} e.g. `6.6s`, `0s`, `1m 12s`.
 */
function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Token counts, abbreviated — a footer has no room for seven digits.
 * @param {number} n - a token count.
 * @returns {string} e.g. `27.5K`, `516`.
 */
function tokens(n) {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}

/**
 * The one-line session statistics strip, or an empty string when the harness
 * composes no projection seam to read them from.
 * @param {object | undefined} stats - from `readSessionStats`.
 * @param {(key: string, params?: object) => string} t - translator.
 * @returns {string} the strip, prefixed with a newline, or ''.
 */
export function statsLine(stats, t = EN) {
  if (stats === undefined) return ''
  return `\n${t('stats.line', {
    turns: stats.turns,
    steps: stats.steps,
    llm: duration(stats.llmMs),
    tool: duration(stats.toolMs),
    ttft: duration(stats.ttftMs),
    rate: Math.round(stats.tokensPerSecond),
    cache: `${Math.round(stats.cacheHit * 100)}%`,
    input: tokens(stats.inputTokens),
    output: tokens(stats.outputTokens),
  })}`
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
function when(value, t = EN) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return t('common.unknownTime')
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
function fitOrAttach(lines, { keep, filename }, t = EN) {
  const joined = lines.join('\n')
  if (joined.length <= DESCRIPTION_BUDGET) return { description: joined || t('common.nothing'), files: [] }

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
  const note = `\n${t('common.overflow', { count: dropped, file: filename })}`
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
export function renderSessions(workspace, sessions, t = EN) {
  const title = t('sessions.title', { title: workspace.title })
  if (sessions.length === 0) {
    return { embeds: [new EmbedBuilder().setColor(COLOR_WARN).setTitle(title).setDescription(t('sessions.empty'))] }
  }

  const total = sessions[0].total
  const lines = sessions.map((session) => {
    const flags = [session.live ? '🟢' : '⚪', session.hasParent ? '↳' : '', session.accounted ? '' : t('sessions.unlisted')].filter(Boolean).join('')
    const label = session.title === undefined ? t('sessions.untitled') : clip(sanitize(session.title), 60)
    return `${flags} \`${session.short}\` ${label} · ${when(session.createdAt)}`
  })

  const { description, files } = fitOrAttach(lines, { keep: 'head', filename: 'sessions.txt' }, t)
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: t('sessions.footer', { shown: sessions.length, total, path: workspace.path }) })

  return { embeds: [embed], files }
}

/**
 * Render a semantic trajectory: what was actually said and done, oldest-first.
 * @param {object} session - the resolved session summary.
 * @param {{entries: object[], total: number}} trajectory - from `readTrajectory`.
 * @returns {object} an interaction reply payload.
 */
export function renderTrajectory(session, trajectory, t = EN, stats) {
  const lines = trajectory.entries.map((entry) => {
    const label = TYPE_LABEL[entry.type] === undefined ? `· ${entry.type}` : t(TYPE_LABEL[entry.type])
    const shadow = entry.surface === 'shadowed' ? t('trace.compacted') : ''
    const text = entry.text.length === 0 ? t('trace.noText') : clip(sanitize(entry.text), ENTRY_BUDGET)
    return `**${label}** \`#${entry.seq}\` ${when(entry.time)}${shadow}\n${text}`
  })

  const { description, files } = fitOrAttach(lines, { keep: 'tail', filename: `trace-${session.short}.txt` }, t)
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('trace.title', { title: session.title ?? session.short }))
    .setDescription(description)
    .setFooter({ text: t('trace.footer', { shown: trajectory.entries.length, total: trajectory.total, short: session.short }) + statsLine(stats, t) })

  return { embeds: [embed], files }
}

/**
 * Render the structural event timeline plus a type histogram.
 * @param {object} session - the resolved session summary.
 * @param {{entries: object[], total: number, counts: [string, number][]}} timeline - from `readTimeline`.
 * @returns {object} an interaction reply payload.
 */
export function renderTimeline(session, timeline, t = EN, stats) {
  const lines = timeline.entries.map((entry) => `\`#${String(entry.seq).padStart(5)}\` ${entry.type} · ${when(entry.time)}${entry.surface === 'log-only' ? '' : ` · ${entry.surface}`}`)
  const { description, files } = fitOrAttach(lines, { keep: 'tail', filename: `timeline-${session.short}.txt` }, t)

  const histogram = timeline.counts.slice(0, 8).map(([type, count]) => `\`${count}×\` ${type}`).join(' · ')
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('timeline.title', { title: session.title ?? session.short }))
    .setDescription(description)
    .addFields({ name: t('timeline.types'), value: histogram || t('common.none') })
    .setFooter({ text: t('timeline.footer', { shown: timeline.entries.length, total: timeline.total, short: session.short }) + statsLine(stats, t) })

  return { embeds: [embed], files }
}

/**
 * Render a subagent listing as an indented tree.
 * @param {object} session - the resolved parent session summary.
 * @param {object[]} entries - from `listSubagents`.
 * @param {boolean} deep - whether the listing walked descendants.
 * @returns {object} an interaction reply payload.
 */
export function renderSubagents(session, entries, deep, t = EN) {
  const title = t('subagents.title', { title: session.title ?? session.short })
  if (entries.length === 0) {
    return {
      embeds: [new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle(title)
        .setDescription(t(deep ? 'subagents.noneDeep' : 'subagents.noneDirect'))
        .setFooter({ text: `session ${session.short}` })],
    }
  }

  const lines = entries.map((entry) => {
    const indent = '  '.repeat(Math.max(0, (entry.depth ?? 1) - 1))
    if (entry.kind === 'diagnostic') return `${indent}⚠️ \`${entry.short}\` ${t('subagents.unreadable', { reason: entry.reason })}`

    const dot = entry.activity === 'running' ? '🟢' : '⚪'
    const label = entry.label === undefined ? t('subagents.unlabelled') : clip(sanitize(entry.label), 70)
    const more = entry.hasChildren && !deep ? ' ▸' : ''
    return `${indent}${dot} \`${entry.short}\` **${entry.mode}** ${label}${more}`
  })

  const running = entries.filter((entry) => entry.activity === 'running').length
  const { description, files } = fitOrAttach(lines, { keep: 'head', filename: `subagents-${session.short}.txt` }, t)
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: t('subagents.footer', {
      count: entries.length,
      kind: t(deep ? 'subagents.kind.deep' : 'subagents.kind.direct'),
      running,
      short: session.short,
    }) })

  return { embeds: [embed], files }
}

/**
 * Render a session's lineage: ancestry outward, then descendant trees.
 * @param {object} session - the resolved session summary.
 * @param {object} lineage - from `readLineage`.
 * @returns {object} an interaction reply payload.
 */
export function renderLineage(session, lineage, t = EN) {
  const ancestors = lineage.ancestors.length === 0
    ? t('lineage.root')
    : lineage.ancestors.map((record, index) => `${'  '.repeat(index)}↑ \`${record.short}\`${record.live ? ' 🟢' : ''}`).join('\n')

  const descendants = lineage.descendants.length === 0
    ? t('lineage.none')
    : lineage.descendants.map((record) => `${'  '.repeat(record.depth - 1)}↳ \`${record.short}\`${record.live ? ' 🟢' : ''}`).join('\n')

  const embed = new EmbedBuilder()
    .setColor(lineage.complete ? COLOR_OK : COLOR_WARN)
    .setTitle(t('lineage.title', { title: session.title ?? session.short }))
    .addFields(
      { name: t('lineage.ancestors'), value: ancestors.slice(0, 1000) },
      { name: t('lineage.descendants'), value: descendants.slice(0, 1000) },
    )
    .setFooter({
      text: lineage.complete
        ? t('lineage.complete', { short: session.short })
        : t('lineage.partial', { parent: lineage.unresolvedParentId }),
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
export function renderStatus(overview, workspaces, meta, t = EN) {
  const services = Object.entries(overview.services)
    .map(([name, mounted]) => `${mounted ? '✅' : '➖'} \`${name}\``)
    .join('\n')

  const list = workspaces.length === 0
    ? t('common.none')
    : workspaces.slice(0, 20).map((workspace) => t('status.workspaceRow', {
        title: clip(sanitize(workspace.title), 40),
        count: workspace.sessionIds.length,
        synthetic: workspace.synthetic ? t('status.fromCwd') : '',
      })).join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('status.title'))
    .setDescription(t('status.blurb'))
    .addFields(
      { name: t('status.services'), value: services, inline: true },
      { name: t('status.sessions'), value: t('status.sessionCounts', { total: overview.sessions.total, live: overview.sessions.live }), inline: true },
      { name: t('status.workspaces', { category: meta.categoryName }), value: list },
    )
    .setFooter({ text: t('status.footer', { mapped: meta.mapped }) })

  return { embeds: [embed] }
}

/**
 * Render the current default model and the catalog around it.
 * @param {object} selection - from `readModelSelection`.
 * @returns {object} an interaction reply payload.
 */
export function renderModel(selection, t = EN) {
  const { current, models, providers } = selection

  const list = models.length === 0
    ? t('model.noCatalog')
    : models
      .map((model) => `${model.id === current.model ? '▸ **' : '  '}\`${model.id}\`${model.id === current.model ? '**' : ''} ${clip(sanitize(model.description ?? model.name), 60)}`)
      .join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('model.title'))
    .setDescription(t('model.current', {
      provider: current.provider,
      model: current.model,
      effort: current.reasoningEffort === undefined ? '' : t('model.effort', { effort: current.reasoningEffort }),
    }))
    .addFields({ name: t('model.catalog', { provider: current.provider }), value: list.slice(0, 1000) })
    .setFooter({ text: t('model.providers', { providers: providers.map((provider) => provider.id).join(', ') || t('common.none') }) })

  return { embeds: [embed] }
}

/**
 * Render the outcome of a model switch.
 * @param {object} change - from `switchModel`.
 * @returns {object} an interaction reply payload.
 */
export function renderModelSwitched(change, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('model.changed'))
    .setDescription(t('model.changedBody', {
      before: `${change.before.provider}/${change.before.model}`,
      after: `${change.after.provider}/${change.after.model}`,
    }))
    .setFooter({ text: t('model.changedFooter') })

  return { embeds: [embed] }
}

/**
 * Render a newly registered workspace.
 * @param {object} workspace - from `createWorkspace`.
 * @param {string | undefined} channelName - the channel created for it, if any.
 * @returns {object} an interaction reply payload.
 */
export function renderWorkspaceCreated(workspace, channelName, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t(workspace.alreadyRegistered ? 'workspace.already' : 'workspace.registered'))
    .setDescription(`**${clip(sanitize(workspace.title), 60)}**\n\`${workspace.path}\``)
    .addFields(
      { name: t('workspace.sessions'), value: String(workspace.sessions), inline: true },
      { name: t('workspace.channel'), value: channelName === undefined ? t('workspace.noChannel') : `#${channelName}`, inline: true },
    )

  return { embeds: [embed] }
}

/**
 * Render a failure as a reply the operator can act on.
 * @param {unknown} error - the thrown value.
 * @returns {object} an interaction reply payload.
 */
export function renderError(error, t = EN) {
  // A TranslatableError carries its key, so the reader sees their own language
  // while the logged `message` stays English and searchable.
  const message = typeof error?.key === 'string'
    ? t(error.key, error.params ?? {})
    : (error instanceof Error ? error.message : String(error))
  return {
    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(t('error.title')).setDescription(clip(sanitize(message), 1500))],
  }
}

/**
 * Render the getting-started card.
 *
 * Built from the same command descriptions Discord shows in its picker, so the
 * help text and the picker can never drift apart — and so a new language only
 * has to be written once.
 *
 * @param {object} meta - what this deployment currently allows.
 * @param {string} meta.categoryName - the workspace category.
 * @param {boolean} meta.allowRun - whether `/dsh run` is enabled.
 * @param {string} meta.chatMode - `off`, `mention` or `all`.
 * @param {(key: string, params?: object) => string} t - translator.
 * @returns {object} an interaction reply payload.
 */
export function renderHelp(meta, t = EN) {
  const cmd = COMMANDS[t.lang] ?? COMMANDS.en
  const row = (name, key) => `\`/dsh ${name}\` — ${cmd[key] ?? ''}`

  const reads = ['sessions', 'trace', 'timeline', 'subagents', 'lineage', 'status']
    .map((name) => row(name, `cmd.${name}`)).join('\n')
  const writes = ['workspace', 'model', 'sync'].map((name) => row(name, `cmd.${name}`)).join('\n')

  const runLines = [row('run', 'cmd.run')]
  runLines.push(meta.allowRun
    ? t('help.chat', { mode: meta.chatMode, hint: t(`help.mode.${meta.chatMode}`) })
    : t('help.runOff'))

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('help.title'))
    .setDescription(t('help.intro', { category: meta.categoryName }))
    .addFields(
      { name: t('help.reads'), value: reads },
      { name: t('help.writes'), value: writes },
      { name: t('help.run'), value: runLines.join('\n') },
    )
    .setFooter({ text: t('help.footer', { language: t.lang }) })

  return { embeds: [embed] }
}
