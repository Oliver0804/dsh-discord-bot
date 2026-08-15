import { ActionRowBuilder, AttachmentBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js'

import { COMMANDS, translator } from './i18n.js'
import { currentPeriod, estimate, formatAmount } from './pricing.js'
import { TYPE_LABEL } from './queries.js'

/** Fallback translator, so a caller that passes none still gets English. */
const EN = translator('en')

/** Embed description ceiling Discord enforces; leave room for the tail note. */
const DESCRIPTION_BUDGET = 3800
/** Per-entry text budget, so one long tool result cannot eat a whole page. */
const ENTRY_BUDGET = 320
/** Entry types whose text is machine output, not prose meant to render. */
const TOOL_TYPES = new Set(['tool/call', 'tool/result'])

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
  const line = t('stats.line', {
    turns: stats.turns,
    steps: stats.steps,
    llm: duration(stats.llmMs),
    tool: duration(stats.toolMs),
    ttft: duration(stats.ttftMs),
    rate: Math.round(stats.tokensPerSecond),
    cache: `${Math.round(stats.cacheHit * 100)}%`,
    input: tokens(stats.inputTokens),
    output: tokens(stats.outputTokens),
  })

  // A separate segment, not a field in the line above: a model with no
  // published price gets no estimate at all, and a fixed template has no way
  // to leave one of its own placeholders out.
  const cost = estimate(stats, stats.model)
  return `\n${line}${cost === undefined ? '' : ` | ${t('stats.cost', { amount: formatAmount(cost) })}`}`
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
 * Stop a tool's own output from being read as Discord markdown.
 *
 * A tool result is data, not formatting. `sed -n '1,240p' README.md` returns a
 * file whose first line is `# Blogger MCP Server`, and Discord renders that as
 * a heading several times the size of the surrounding text — one file read
 * swallows the whole trace. The marker is prefixed with a zero-width space
 * rather than escaped: the character survives verbatim for anyone reading or
 * copying it, and nothing is added that would show up in the attachment a long
 * trace spills into. It is the trick {@link sanitize} already uses on `@`.
 *
 * Only tool entries go through this. An assistant's own prose is written as
 * markdown and is meant to render.
 *
 * @param {string} text - sanitized text from a tool call or result.
 * @returns {string} text Discord renders literally.
 */
function literal(text) {
  return text.replace(/^(\s*)(#{1,3}|>+|[*+-]|\d+[.)])(\s)/gm, '$1​$2$3')
}

/**
 * Clip a multi-line block to a budget, keeping its line breaks.
 *
 * {@link clip} flattens newlines into `⏎` markers, which is right for one entry
 * inside a line and wrong for a list: a command roster or a todo list rendered
 * through it arrives as one run-on paragraph.
 *
 * @param {string} text - already-composed lines.
 * @param {number} max - maximum characters to keep.
 * @returns {string} the block, clipped on a character boundary.
 */
function clipBlock(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
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
 * Render full-text search hits for one workspace.
 *
 * Hits arrive ranked by the harness's own search (strongest matching event
 * first), so this keeps that order instead of re-sorting by age. Each hit is
 * one line: live marker, short id, when the session was created, the matching
 * event's position, and a bounded excerpt. The footer tells the reader how to
 * open a hit — the whole point is that `/dsh trace <short>` is one step away.
 *
 * @param {import('./workspaces.js').WorkspaceView} workspace - the channel's workspace.
 * @param {string} query - the searched text, echoed for context.
 * @param {{total: number, hits: object[]}} results - from `searchWorkspaceSessions`.
 * @returns {object} an interaction reply payload.
 */
export function renderSearchResults(workspace, query, results, t = EN) {
  const title = t('search.title', { query: clip(query, 60) })
  if (results.hits.length === 0) {
    return { embeds: [new EmbedBuilder().setColor(COLOR_WARN).setTitle(title).setDescription(t('search.empty', { query }))] }
  }

  const lines = results.hits.map((hit) => {
    const live = hit.live ? '🟢' : '⚪'
    const type = hit.type === undefined ? '' : ` #${hit.seq} ${hit.type}`
    const snippet = hit.snippet === undefined ? '' : clip(sanitize(hit.snippet), 240)
    return t('search.hit', {
      short: hit.short,
      live,
      time: when(hit.time ?? hit.createdAt),
      seq: hit.seq ?? '?',
      type,
      snippet: snippet.length === 0 ? '_no excerpt_' : snippet,
    })
  })

  const { description, files } = fitOrAttach(lines, { keep: 'head', filename: `search-${workspace.id}.txt` }, t)
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: t('search.footer', { query: clip(query, 60), count: results.total }) })

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
    const raw = TOOL_TYPES.has(entry.type) ? literal(sanitize(entry.text)) : sanitize(entry.text)
    const text = entry.text.length === 0 ? t('trace.noText') : clip(raw, ENTRY_BUDGET)
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
 * Which half of the day the next request will be billed at, and when that ends.
 *
 * The stats strip prices sessions that already ran; this answers the other
 * question — whether starting something long right now costs double. It belongs
 * on the status card rather than in a footer, which describes the past.
 *
 * @param {Date | undefined} now - the instant to read; defaults to the clock.
 * @param {(key: string, params?: object) => string} t - translator.
 * @returns {string} the period and its boundary.
 */
function pricingNow(now, t) {
  const period = currentPeriod(now ?? new Date())
  return t(period.peak ? 'status.peak' : 'status.offPeak', { until: period.until })
}

/**
 * Render the harness overview shown by `/dsh status`.
 * @param {object} overview - from `readOverview`.
 * @param {import('./workspaces.js').WorkspaceView[]} workspaces - mapped workspaces.
 * @param {object} meta - bot-side facts.
 * @param {string} meta.categoryName - the Discord category in use.
 * @param {number} meta.mapped - how many channels are currently mapped.
 * @param {Date} [meta.now] - the instant to price against; defaults to now.
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
      {
        name: t('status.sessions'),
        value: t('status.sessionCounts', { total: overview.sessions.total, live: overview.sessions.live })
          + (meta.running === undefined ? '' : `\n${t('status.running', { running: meta.running })}`),
        inline: true,
      },
      { name: t('status.pricing'), value: pricingNow(meta.now, t), inline: true },
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
    .addFields({ name: t('model.catalog', { provider: current.provider }), value: clipBlock(list, 1000) })
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

/** Component-id prefix for the rewind picker, distinct from the menu card's. */
export const REWIND_PREFIX = 'dsh:rewind'

/**
 * Render the rewind picker: the prompts this session can be taken back to.
 *
 * The newest 25 fit, which is the right end to keep — a rewind is almost always
 * "undo the last thing", and Discord allows no more options than that anyway.
 *
 * @param {object} session - the session summary.
 * @param {object[]} points - from `rewindPoints`.
 * @returns {object} an interaction reply payload.
 */
export function renderRewindCard(session, points, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_WARN)
    .setTitle(t('rewind.title', { short: session.short }))
    .setDescription(points.length === 0 ? t('rewind.empty') : t('rewind.blurb'))

  if (points.length === 0) return { embeds: [embed] }

  const options = points.slice(-25).map((point) => ({
    label: clip(sanitize(point.text), 90) || `#${point.seq}`,
    value: String(point.seq),
    description: `#${point.seq}`,
  }))

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${REWIND_PREFIX}:${session.short}`)
      .setPlaceholder(t('rewind.pick'))
      .addOptions(options),
  )

  return { embeds: [embed], components: [row] }
}

/**
 * Render a completed rewind.
 * @param {object} result - from `rewindSession`.
 * @returns {object} an interaction reply payload.
 */
export function renderRewound(result, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('rewind.done'))
    .setDescription(t('rewind.body', { from: result.from, short: result.short, kept: result.kept, dropped: result.dropped }))
    .setFooter({ text: t('rewind.footer', { from: result.from }) })

  return { embeds: [embed], components: [] }
}

/**
 * Render what a live agent's model sees.
 * @param {object} context - from `readAgentContext`.
 * @returns {object} an interaction reply payload.
 */
export function renderAgentContext(context, t = EN) {
  const column = (items, empty) => (items.length === 0
    ? empty
    : clipBlock(items.map((item) => `• ${clip(sanitize(item.name ?? String(item)), 40)}`).join('\n'), 1000))

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('context.title', { short: context.short }))
    .setDescription(t('context.blurb', {
      sections: context.sections.length,
      tools: context.tools.length,
      skills: context.skills.length,
    }))
    .addFields(
      { name: t('context.sections'), value: column(context.sections.map((name) => ({ name })), t('common.none')), inline: true },
      { name: t('context.tools'), value: column(context.tools, t('common.none')), inline: true },
      { name: t('context.skills'), value: column(context.skills, t('common.none')), inline: true },
    )

  return { embeds: [embed] }
}

/**
 * Render an exported session as a Markdown attachment. The whole point is the
 * file, so the message says only what is in it.
 * @param {object} session - the session summary.
 * @param {object} exported - from `exportSession`.
 * @returns {object} an interaction reply payload.
 */
export function renderExport(session, exported, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('export.title', { short: session.short }))
    .setDescription(t('export.body', { entries: exported.entries }))

  return {
    embeds: [embed],
    files: [new AttachmentBuilder(Buffer.from(exported.markdown, 'utf8'), { name: `session-${session.short}.md` })],
  }
}

/**
 * Render a prompt that was steered into a turn already in flight.
 *
 * Deliberately terse and final: this reply cannot report the turn, because the
 * turn belongs to whoever started it. The mirror — or `/dsh trace` — is where
 * the answer shows up.
 *
 * @param {object} steer - the session and the text delivered.
 * @returns {object} an interaction reply payload.
 */
export function renderSteered(steer, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('steer.title'))
    .setDescription(`> ${clip(sanitize(steer.prompt), 300)}\n\n${t('steer.body')}`)
    .setFooter({ text: t('steer.footer', { short: steer.short }) })

  return { embeds: [embed] }
}

/**
 * Render an interrupted turn.
 * @param {object} stopped - from `cancelSession`.
 * @returns {object} an interaction reply payload.
 */
export function renderStopped(stopped, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_WARN)
    .setTitle(t('stop.title'))
    .setDescription(t(stopped.wasRunning ? 'stop.interrupted' : 'stop.idle', { short: stopped.short }))
    .setFooter({ text: t(stopped.hadPending ? 'stop.discarded' : 'stop.footer') })

  return { embeds: [embed] }
}

/**
 * Render the harness's own command registry.
 * @param {object[]} commands - from `listHarnessCommands`.
 * @returns {object} an interaction reply payload.
 */
export function renderHarnessCommands(commands, t = EN) {
  const lines = commands.map((command) => {
    const hint = command.hint === undefined ? '' : ` _${clip(sanitize(command.hint), 30)}_`
    return `\`/${command.name}\`${hint} — ${clip(sanitize(command.description ?? ''), 70)}`
  })

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('harnessCmd.title'))
    .setDescription(lines.length === 0 ? t('harnessCmd.none') : clipBlock(lines.join('\n'), DESCRIPTION_BUDGET))
    .setFooter({ text: t('harnessCmd.footer') })

  return { embeds: [embed] }
}

/**
 * Render one harness command's outcome. A handler that returns no text
 * succeeded silently — its effect is in the session, not in this reply — and
 * saying so beats an empty embed.
 * @param {object} result - from `runHarnessCommand`.
 * @returns {object} an interaction reply payload.
 */
export function renderHarnessCommandResult(result, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(result.ok ? COLOR_OK : 0xed4245)
    .setTitle(t(result.ok ? 'harnessCmd.ran' : 'harnessCmd.failed', { name: result.name }))
    .setDescription(result.text === undefined || result.text.trim().length === 0
      ? t('harnessCmd.silent')
      // A handler's own output is often multi-line usage text; flattening it
      // into ⏎ markers is what `clip` is for and exactly wrong here.
      : clipBlock(sanitize(result.text), DESCRIPTION_BUDGET))

  return { embeds: [embed] }
}

/**
 * One line summarizing a todo list: how much is done, and what is being worked
 * on now. Shown under a mirrored turn, where the question a reader has is
 * "how far along is this" rather than "what are all the steps".
 * @param {object[] | undefined} todos - the latest `todo/write` snapshot.
 * @returns {string | undefined} the line, or undefined when there is no list.
 */
export function todoLine(todos, t = EN) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined

  const done = todos.filter((todo) => todo.status === 'completed').length
  const active = todos.find((todo) => todo.status === 'in_progress')

  return t('todo.line', {
    done,
    total: todos.length,
    current: active === undefined ? t('todo.noneActive') : clip(sanitize(active.content), 80),
  })
}

/**
 * Render a session's whole todo list.
 * @param {object} session - the session summary.
 * @param {object[]} todos - the latest `todo/write` snapshot.
 * @returns {object} an interaction reply payload.
 */
export function renderTodos(session, todos, t = EN) {
  const mark = { completed: '✅', in_progress: '▶️', pending: '⬜️' }
  const lines = todos.map((todo) => `${mark[todo.status] ?? '⬜️'} ${clip(sanitize(todo.content), 120)}`)

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('todo.title', { title: clip(sanitize(session.title ?? session.short), 60) }))
    .setDescription(lines.length === 0 ? t('todo.empty') : clipBlock(lines.join('\n'), DESCRIPTION_BUDGET))
    .setFooter({ text: todoLine(todos, t) ?? t('todo.empty') })

  return { embeds: [embed] }
}

/**
 * Render the agent preset roster and the one new sessions are composed from.
 * @param {object} roster - from `readAgentPresets`.
 * @returns {object} an interaction reply payload.
 */
export function renderPresets(roster, t = EN) {
  const list = roster.presets.length === 0
    ? t('common.none')
    : roster.presets.map((preset) => {
        const marker = preset.id === roster.current ? '▸ **' : '  '
        const close = preset.id === roster.current ? '**' : ''
        const note = preset.broken === undefined
          ? clip(sanitize(preset.description ?? preset.name ?? ''), 60)
          : t('preset.broken', { reason: clip(sanitize(preset.broken), 50) })
        return `${marker}\`${preset.id}\`${close} ${note}`
      }).join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('preset.title'))
    .setDescription(t('preset.current', { id: roster.current }))
    .addFields({ name: t('preset.roster'), value: clipBlock(list, 1000) })
    .setFooter({ text: t('preset.footer') })

  return { embeds: [embed] }
}

/**
 * Render the outcome of an agent preset switch.
 * @param {object} change - from `switchAgentPreset`.
 * @returns {object} an interaction reply payload.
 */
export function renderPresetSwitched(change, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('preset.changed'))
    .setDescription(t('model.changedBody', { before: change.before, after: change.after }))
    .setFooter({ text: t('preset.footer') })

  return { embeds: [embed] }
}

/**
 * Render the permission presets, the default, and one session's effective one.
 * @param {object} state - from `readPermissionPresets`.
 * @returns {object} an interaction reply payload.
 */
export function renderPermissions(state, t = EN) {
  const marked = (id) => (id === (state.session?.current ?? state.default) ? '▸ **' : '  ')
  const list = state.options.length === 0
    ? t('common.none')
    : state.options.map((option) => {
        const close = marked(option.id) === '  ' ? '' : '**'
        const knobs = [option.sandbox, option.approval].filter(Boolean).join(' · ')
        return `${marked(option.id)}\`${option.id}\`${close} ${clip(sanitize(option.description ?? option.name ?? ''), 50)}${knobs === '' ? '' : ` — \`${knobs}\``}`
      }).join('\n')

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle(t('permission.title'))
    .setDescription(state.session === undefined
      ? t('permission.default', { name: state.default })
      : t('permission.session', { short: state.session.short, current: state.session.current, name: state.default }))
    .addFields({ name: t('permission.presets'), value: clipBlock(list, 1000) })
    .setFooter({ text: t('permission.footer') })

  return { embeds: [embed] }
}

/**
 * Render the outcome of a permission switch, naming what it applied to: a
 * default that governs future sessions is a different promise from a live
 * session whose next tool call is already affected.
 * @param {object} change - from `switchPermissionPreset`.
 * @returns {object} an interaction reply payload.
 */
export function renderPermissionSwitched(change, t = EN) {
  const embed = new EmbedBuilder()
    .setColor(change.after === 'danger-full-access' ? COLOR_WARN : COLOR_OK)
    .setTitle(t(change.scope === 'session' ? 'permission.changedSession' : 'permission.changedDefault'))
    .setDescription(t('model.changedBody', { before: change.before, after: change.after }))
    .setFooter({ text: change.scope === 'session' ? t('permission.scopeSession', { short: change.short }) : t('permission.scopeDefault') })

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
 * @param {boolean} meta.mirror - whether harness activity is pushed into channels.
 * @param {(key: string, params?: object) => string} t - translator.
 * @returns {object} an interaction reply payload.
 */
export function renderHelp(meta, t = EN) {
  const cmd = COMMANDS[t.lang] ?? COMMANDS.en
  const row = (name, key) => `\`/dsh ${name}\` — ${cmd[key] ?? ''}`

  const reads = ['menu', 'sessions', 'trace', 'timeline', 'todos', 'subagents', 'lineage', 'context', 'export', 'status']
    .map((name) => row(name, `cmd.${name}`)).join('\n')
  const writes = ['workspace', 'model', 'preset', 'permission', 'sync']
    .map((name) => row(name, `cmd.${name}`)).join('\n')

  const runLines = [row('run', 'cmd.run'), row('cmd', 'cmd.cmd'), row('stop', 'cmd.stop'), row('rewind', 'cmd.rewind')]
  runLines.push(meta.allowRun
    ? t('help.chat', { mode: meta.chatMode, hint: t(`help.mode.${meta.chatMode}`) })
    : t('help.runOff'))
  runLines.push(meta.mirror ? t('help.mirrorOn') : t('help.mirrorOff'))

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
