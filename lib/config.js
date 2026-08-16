import { readFileSync } from 'node:fs'

import { LANGUAGES } from './i18n.js'

/**
 * Configuration handling, with no dependency on the harness's own packages.
 *
 * This plugin deliberately imports nothing from `@deepseek-ai/*`. A plugin
 * installed into a profile gets its own `node_modules`, so importing the
 * harness's `Service` or `schemastery` there would bind against a *second*
 * copy of those packages — a different class identity than the host holds, and
 * a failure that shows up as a service that silently never registers. Keeping
 * the contact surface to the `ctx` object passed into `apply` removes the
 * failure mode entirely, at the cost of validating config by hand here.
 */

/** Defaults for every optional field. */
const DEFAULTS = {
  token: undefined,
  tokenFile: undefined,
  categoryName: 'dsh',
  allowedUserIds: [],
  manageChannels: true,
  privateChannels: true,
  allowRun: false,
  listenToMessages: 'off',
  runVerbosity: 'minimal',
  language: 'auto',
  mirror: false,
  mirrorSubagents: false,
  mirrorNewSessions: true,
  mirrorApprovals: false,
  sessionThreads: false,
  sessionThreadsBackfill: 5,
  answerQuestions: false,
  followNewWorkspaces: true,
  traceLimit: 25,
  sessionLimit: 15,
  retrySeconds: 30,
}

/**
 * @param {unknown} value - the raw value.
 * @param {boolean} fallback - the default.
 * @param {string} key - field name, for the error message.
 * @param {string[]} errors - collected problems.
 * @returns {boolean} the coerced value.
 */
function asBoolean(value, fallback, key, errors) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    errors.push(`\`${key}\` must be true or false`)
    return fallback
  }
  return value
}

/**
 * @param {unknown} value - the raw value.
 * @param {number} fallback - the default.
 * @param {object} bounds - inclusive `min` and `max`.
 * @param {string} key - field name, for the error message.
 * @param {string[]} errors - collected problems.
 * @returns {number} the coerced value.
 */
function asInteger(value, fallback, { min, max }, key, errors) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`\`${key}\` must be an integer between ${min} and ${max}`)
    return fallback
  }
  return value
}

/**
 * @param {unknown} value - the raw value.
 * @param {string} key - field name, for the error message.
 * @param {string[]} errors - collected problems.
 * @returns {string | undefined} the trimmed value, when present and non-empty.
 */
function asOptionalString(value, key, errors) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    errors.push(`\`${key}\` must be a string`)
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Chat-mode settings, in ascending order of how much they listen to. */
const CHAT_MODES = ['off', 'mention', 'all']

/**
 * Validate the chat trigger.
 *
 * Anything but `off` makes the bot request the Message Content privileged
 * intent, which must be enabled in the Developer Portal first — Discord refuses
 * the whole connection otherwise. That coupling is why this is a named mode
 * rather than a boolean: `mention` gets conversational use without turning
 * every stray line in the channel into work.
 *
 * @param {unknown} value - the raw value.
 * @param {string[]} errors - collected problems.
 * @returns {'off' | 'mention' | 'all'} the resolved mode.
 */
function asChatMode(value, errors) {
  if (value === undefined) return DEFAULTS.listenToMessages
  if (value === false) return 'off'
  if (value === true) return 'mention'
  if (typeof value !== 'string' || !CHAT_MODES.includes(value)) {
    errors.push(`\`listenToMessages\` must be one of ${CHAT_MODES.map((mode) => `"${mode}"`).join(', ')}`)
    return DEFAULTS.listenToMessages
  }
  return value
}

/**
 * Validate the reply language.
 *
 * `auto` follows the locale of whoever invoked the command, which is as close
 * to per-viewer as a shared channel message gets. Command names and
 * descriptions are always localized by Discord itself and ignore this.
 *
 * @param {unknown} value - the raw value.
 * @param {string[]} errors - collected problems.
 * @returns {string} the resolved language.
 */
function asLanguage(value, errors) {
  if (value === undefined) return DEFAULTS.language
  const allowed = ['auto', ...LANGUAGES]
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`\`language\` must be one of ${allowed.map((lang) => `"${lang}"`).join(', ')}`)
    return DEFAULTS.language
  }
  return value
}

/** How much of a run to show in Discord. */
const VERBOSITY = ['minimal', 'full']

/**
 * Validate the run transcript level.
 *
 * `minimal` is the default because the common case is asking for something and
 * wanting the answer: a live transcript of every tool call reads as noise on a
 * phone. `full` is for watching how a turn works rather than what it concluded.
 *
 * @param {unknown} value - the raw value.
 * @param {string[]} errors - collected problems.
 * @returns {'minimal' | 'full'} the resolved level.
 */
function asVerbosity(value, errors) {
  if (value === undefined) return DEFAULTS.runVerbosity
  if (typeof value !== 'string' || !VERBOSITY.includes(value)) {
    errors.push(`\`runVerbosity\` must be one of ${VERBOSITY.map((level) => `"${level}"`).join(', ')}`)
    return DEFAULTS.runVerbosity
  }
  return value
}

/**
 * Validate and complete a raw config row.
 *
 * Every failure is collected and reported at once: an operator editing YAML
 * over SSH should learn about all four mistakes in one restart, not one per
 * restart.
 *
 * @param {object} [raw] - the row's `config` mapping.
 * @returns {object} the validated, defaulted config.
 * @throws {Error} when any field is invalid.
 */
export function normalizeConfig(raw = {}) {
  /** @type {string[]} */
  const errors = []

  // Unset and wrong are different failures, and only the first one is tolerated.
  // The bundle layer this package ships mounts the plugin the moment it is
  // installed, which is *before* anyone has written a config override — and a
  // throw here is an activation failure, which Cordis treats as a failed
  // composition and which would stop dsh from booting at all. So a missing
  // guildId parks the bridge offline exactly as a missing token does. A
  // malformed one still throws: that is an operator typo, and a plugin that
  // quietly ignored it would be the unhelpful kind of tolerant.
  const guildId = asOptionalString(raw.guildId, 'guildId', errors)
  if (guildId !== undefined && !/^\d{5,25}$/.test(guildId)) {
    errors.push('`guildId` must be a numeric Discord snowflake')
  }

  let allowedUserIds = DEFAULTS.allowedUserIds
  if (raw.allowedUserIds !== undefined) {
    if (!Array.isArray(raw.allowedUserIds) || raw.allowedUserIds.some((id) => typeof id !== 'string')) {
      errors.push('`allowedUserIds` must be a list of Discord user id strings')
    } else {
      allowedUserIds = raw.allowedUserIds.map((id) => id.trim()).filter((id) => id.length > 0)
    }
  }

  const config = {
    token: asOptionalString(raw.token, 'token', errors),
    tokenFile: asOptionalString(raw.tokenFile, 'tokenFile', errors),
    guildId,
    categoryName: asOptionalString(raw.categoryName, 'categoryName', errors) ?? DEFAULTS.categoryName,
    allowedUserIds,
    manageChannels: asBoolean(raw.manageChannels, DEFAULTS.manageChannels, 'manageChannels', errors),
    privateChannels: asBoolean(raw.privateChannels, DEFAULTS.privateChannels, 'privateChannels', errors),
    // Off by default, and deliberately so: turning this on lets everyone on
    // `allowedUserIds` run an agent on this machine from a chat app.
    allowRun: asBoolean(raw.allowRun, DEFAULTS.allowRun, 'allowRun', errors),
    listenToMessages: asChatMode(raw.listenToMessages, errors),
    runVerbosity: asVerbosity(raw.runVerbosity, errors),
    language: asLanguage(raw.language, errors),
    // Off by default for the same reason `allowRun` is: turning it on exports
    // every session's conversation — including work started at the machine
    // itself — into a chat platform, continuously and without anyone asking.
    mirror: asBoolean(raw.mirror, DEFAULTS.mirror, 'mirror', errors),
    mirrorSubagents: asBoolean(raw.mirrorSubagents, DEFAULTS.mirrorSubagents, 'mirrorSubagents', errors),
    mirrorNewSessions: asBoolean(raw.mirrorNewSessions, DEFAULTS.mirrorNewSessions, 'mirrorNewSessions', errors),
    // Separate from `mirror`: answering a question is a decision, not a view.
    mirrorApprovals: asBoolean(raw.mirrorApprovals, DEFAULTS.mirrorApprovals, 'mirrorApprovals', errors),
    // Give each session its own thread under the workspace channel, instead of
    // interleaving every session's turns in one. Off by default because it
    // changes where an existing deployment's messages appear — but it is what
    // makes two concurrent sessions readable, and it removes the guesswork from
    // "which conversation did that command mean": inside a thread, the thread
    // is the answer.
    sessionThreads: asBoolean(raw.sessionThreads, DEFAULTS.sessionThreads, 'sessionThreads', errors),
    // How many of a workspace's most recent sessions get a thread up front,
    // rather than waiting for each to say something. Capped low on purpose:
    // every backfilled thread costs a log read for its summary card and two
    // Discord calls, and a corpus of a hundred old sessions is not a sidebar
    // anyone wants. `0` waits for activity, which is the old behavior.
    sessionThreadsBackfill: asInteger(raw.sessionThreadsBackfill, DEFAULTS.sessionThreadsBackfill, { min: 0, max: 25 }, 'sessionThreadsBackfill', errors),
    // Unlike approvals, the user-questions seam takes ONE provider and throws
    // on the second. Claiming it here would take the questionnaire away from
    // whichever UI a person is actually looking at, so it is asked for
    // explicitly and never assumed.
    answerQuestions: asBoolean(raw.answerQuestions, DEFAULTS.answerQuestions, 'answerQuestions', errors),
    followNewWorkspaces: asBoolean(raw.followNewWorkspaces, DEFAULTS.followNewWorkspaces, 'followNewWorkspaces', errors),
    traceLimit: asInteger(raw.traceLimit, DEFAULTS.traceLimit, { min: 1, max: 200 }, 'traceLimit', errors),
    sessionLimit: asInteger(raw.sessionLimit, DEFAULTS.sessionLimit, { min: 1, max: 50 }, 'sessionLimit', errors),
    retrySeconds: asInteger(raw.retrySeconds, DEFAULTS.retrySeconds, { min: 5, max: 3600 }, 'retrySeconds', errors),
  }

  if (errors.length > 0) throw new Error(`dsh-discord-bot config: ${errors.join('; ')}`)
  return config
}

/**
 * Resolve the bot token from the three supported sources, in precedence order:
 * explicit config, a token file, then the environment. Returns `undefined`
 * when none supplies one — the caller keeps the harness running and logs.
 * @param {object} config - the validated plugin config.
 * @returns {string | undefined} the token, or undefined when unconfigured.
 */
export function resolveToken(config) {
  if (config.token !== undefined) return config.token

  if (config.tokenFile !== undefined) {
    // A missing or unreadable token file is a configuration error the operator
    // must see, but it must not take the harness down with it.
    try {
      const line = readFileSync(config.tokenFile, 'utf8')
        .split('\n')
        .map((value) => value.trim())
        .find((value) => value.length > 0 && !value.startsWith('#'))
      if (line !== undefined) return line.replace(/^[A-Z_]+=/, '')
    } catch {
      return undefined
    }
  }

  const env = process.env.DSH_DISCORD_BOT_TOKEN?.trim() || process.env.DISCORD_BOT_TOKEN?.trim()
  return env || undefined
}

/**
 * Whether a Discord user may run commands: the configured allowlist, or the
 * guild owner when that list is empty.
 * @param {object} config - the validated plugin config.
 * @param {string} userId - the interacting Discord user id.
 * @param {string | undefined} ownerId - the guild owner's id.
 * @returns {boolean} true when the user is authorized.
 */
export function isAuthorized(config, userId, ownerId) {
  if (config.allowedUserIds.length > 0) return config.allowedUserIds.includes(userId)
  return ownerId !== undefined && userId === ownerId
}
