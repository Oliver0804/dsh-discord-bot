#!/usr/bin/env node
/**
 * Install this plugin into a dsh profile and write its patch row.
 *
 * The composition file is the user's, and it is hand-edited and commented, so
 * this script only ever appends a complete row — it never rewrites, reorders,
 * or reformats what is already there, and it refuses outright when a row for
 * this plugin already exists.
 */
import { createInterface } from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROW_ID = 'discord-bot'
const PACKAGE_NAME = 'dsh-discord-bot'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @returns {Record<string, string | boolean>} parsed `--key value` / `--flag` arguments. */
function parseArgs() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i += 1
    }
  }
  return args
}

/** @returns {string} the resolved `$DSH_HOME`. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Build the YAML row appended to the profile's patch layer.
 * @param {object} answers - the collected configuration.
 * @returns {string} a top-level patch entry.
 */
function renderRow(answers) {
  const lines = [
    '',
    '# Added by dsh-discord-bot-setup. Maps every workspace onto one Discord',
    '# category, one channel each, and answers /dsh commands from those channels.',
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: '${PACKAGE_NAME}'`,
    '      config:',
    `        guildId: '${answers.guildId}'`,
    `        categoryName: '${answers.categoryName}'`,
  ]
  if (answers.tokenFile !== undefined) lines.push(`        tokenFile: '${answers.tokenFile}'`)
  if (answers.allowedUserIds.length > 0) {
    lines.push('        allowedUserIds:')
    for (const id of answers.allowedUserIds) lines.push(`          - '${id}'`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The spec handed to `pnpm add`.
 *
 * Deliberately a freshly packed tarball rather than this directory. `pnpm add
 * <dir>` creates a link, and a link breaks both ways that matter: run through
 * `npx`, it would point at a temp directory that disappears; run from a
 * checkout, the linked package resolves its own `node_modules`, which is how a
 * plugin ends up bound to a second copy of a dependency the host also holds.
 * A tarball installs a real, self-contained copy.
 *
 * It lands in `$DSH_HOME`, not the system temp directory: pnpm records the
 * absolute path it was given, and macOS prunes `/var/folders`, so a temp
 * tarball turns into a profile that fails its next `pnpm install` weeks later.
 *
 * @returns {string} an absolute path to the packed tarball.
 */
function installSpec() {
  const destination = dshHome()
  const output = execFileSync('npm', ['pack', '--silent', '--pack-destination', destination], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  const name = output.trim().split('\n').pop()
  if (name === undefined || name.length === 0) throw new Error('npm pack produced no tarball')
  return join(destination, name)
}

/**
 * Refuse early when the profile already carries a row for this plugin. Checked
 * before anything is installed or written, so a second run is a no-op rather
 * than a package install followed by a refusal.
 * @param {string} file - path to the profile's `cordis.patch.yml`.
 */
function assertNotInstalled(file) {
  if (readFileSync(file, 'utf8').includes(PACKAGE_NAME)) {
    throw new Error(`${file} already references ${PACKAGE_NAME}; edit that row instead of adding a second one`)
  }
}

/**
 * Append the row to a profile patch file, preserving everything already there.
 * @param {string} file - path to the profile's `cordis.patch.yml`.
 * @param {string} row - the rendered row.
 */
function appendRow(file, row) {
  assertNotInstalled(file)
  const current = readFileSync(file, 'utf8')

  // A fresh profile ships the empty flow sequence `[]`, which cannot hold an
  // appended block entry — replace just that token and keep the comments above it.
  const withoutEmpty = current.replace(/^\s*\[\]\s*$/m, '')
  writeFileSync(file, `${withoutEmpty.trimEnd()}\n${row}`, 'utf8')
}

async function main() {
  const args = parseArgs()
  const rl = args.yes === true ? undefined : createInterface({ input: process.stdin, output: process.stdout })

  /**
   * @param {string} question - the prompt text.
   * @param {string | undefined} fallback - value used with --yes or an empty answer.
   * @returns {Promise<string>} the answer.
   */
  const ask = async (question, fallback) => {
    const given = args[question.key]
    if (typeof given === 'string') return given
    if (rl === undefined) return fallback ?? ''
    const answer = (await rl.question(`${question.text}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim()
    return answer.length > 0 ? answer : (fallback ?? '')
  }

  const profile = await ask({ key: 'profile', text: 'dsh profile to install into' }, 'web')
  const profileDir = join(dshHome(), 'profiles', profile)
  if (!existsSync(profileDir)) throw new Error(`no such profile: ${profileDir}`)

  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) throw new Error(`profile has no patch layer: ${patchFile}`)
  assertNotInstalled(patchFile)

  const guildId = await ask({ key: 'guild', text: 'Discord guild (server) id' }, undefined)
  if (!/^\d{5,25}$/.test(guildId)) throw new Error('a guild id is a numeric snowflake — enable Developer Mode in Discord, right-click the server, Copy Server ID')

  const categoryName = await ask({ key: 'category', text: 'Discord category name for workspaces' }, 'dsh')
  const token = await ask({ key: 'token', text: 'Bot token (blank to configure it later)' }, '')
  const allowed = await ask({ key: 'allow', text: 'Discord user ids allowed to query, comma separated (blank = guild owner only)' }, '')

  rl?.close()

  /** @type {string | undefined} */
  let tokenFile
  if (token.length > 0) {
    tokenFile = join(dshHome(), 'discord-bot.token')
    writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tokenFile, 0o600)
  }

  const answers = {
    guildId,
    categoryName,
    tokenFile,
    allowedUserIds: allowed.split(',').map((id) => id.trim()).filter((id) => id.length > 0),
  }

  const row = renderRow(answers)

  if (args.print === true) {
    process.stdout.write(`\nAdd this to ${patchFile}:\n${row}\n`)
    return
  }

  process.stdout.write(`\n▸ installing ${PACKAGE_NAME} into ${profileDir}\n`)
  execFileSync('pnpm', ['add', installSpec()], { cwd: profileDir, stdio: 'inherit' })

  appendRow(patchFile, row)
  process.stdout.write(`▸ wrote the plugin row to ${patchFile}\n`)
  if (tokenFile !== undefined) process.stdout.write(`▸ wrote the token to ${tokenFile} (mode 600)\n`)

  process.stdout.write([
    '',
    'Done. Next:',
    `  1. Invite the bot: scopes bot + applications.commands, permissions=268487696 (Manage Roles is required for private channels).`,
    `  2. Restart dsh:  dsh --profile ${profile}`,
    `  3. In Discord, open the "${categoryName}" category and run /dsh status`,
    '',
  ].join('\n'))
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : error}\n\n`)
  process.exitCode = 1
})
