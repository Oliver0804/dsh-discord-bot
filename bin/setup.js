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
 *
 * An id-targeted config override, not an `insert`. The package's own bundle
 * layer is what mounts the plugin, and the two layers do not merge: a second
 * insert of the same id composes a *second* instance, so a profile carrying
 * both would run two bots against one guild and answer every command twice.
 * Overriding leaves one row, filled in — `dsh --dump-config` shows it as
 * "dsh-discord-bot, patched by <this file>".
 *
 * @param {object} answers - the collected configuration.
 * @returns {string} a top-level patch entry.
 */
function renderRow(answers) {
  const lines = [
    '',
    '# Added by dsh-discord-bot-setup. The plugin is mounted by its own bundle',
    '# layer; this row is the configuration that layer deliberately leaves out.',
    '# Maps every workspace onto one Discord category, one channel each, and',
    '# answers /dsh commands from those channels.',
    `- id: ${ROW_ID}`,
    '  config:',
    `    guildId: '${answers.guildId}'`,
    `    categoryName: '${answers.categoryName}'`,
  ]
  if (answers.tokenFile !== undefined) lines.push(`    tokenFile: '${answers.tokenFile}'`)
  if (answers.allowedUserIds.length > 0) {
    lines.push('    allowedUserIds:')
    for (const id of answers.allowedUserIds) lines.push(`      - '${id}'`)
  }
  lines.push('')
  return lines.join('\n')
}

/** @returns {object} this package's own manifest. */
function ownManifest() {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
}

/**
 * The spec handed to `pnpm add`.
 *
 * The published version by default — a registry install is prebuilt, which
 * skips dsh's `allowBuilds` approval step, and it leaves no tarballs piling up
 * in `$DSH_HOME`.
 *
 * From a git checkout it packs that checkout instead, because someone running
 * this script from a clone means the code in front of them, not the last
 * release. Deliberately a freshly packed tarball rather than the directory:
 * `pnpm add <dir>` creates a link, and a linked package resolves its own
 * `node_modules`, which is how a plugin ends up bound to a second copy of a
 * dependency the host also holds. The tarball lands in `$DSH_HOME`, not the
 * system temp directory — pnpm records the absolute path it was given, and
 * macOS prunes `/var/folders`, so a temp tarball turns into a profile that
 * fails its next `pnpm install` weeks later.
 *
 * @returns {string} a registry spec, or an absolute path to a packed tarball.
 */
function installSpec() {
  if (!existsSync(join(packageRoot, '.git'))) return `${PACKAGE_NAME}@${ownManifest().version}`

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
 * Append this package to the profile's bundle list, which is what makes its
 * `cordis.patch.yml` a layer of the composed tree at all.
 *
 * `dsh plugin add` does this itself; `pnpm add` does not, and this script calls
 * pnpm directly so that it works whether or not `dsh` is on the PATH.
 *
 * @param {string} profileDir - the profile directory.
 * @returns {boolean} true when the list was changed.
 */
function registerBundle(profileDir) {
  const file = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`${file} has no dsh.profile.bundles list to register into`)
  if (bundles.includes(PACKAGE_NAME)) return false

  bundles.push(PACKAGE_NAME)
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return true
}

/**
 * Refuse early when the profile already carries a row for this plugin. Checked
 * before anything is installed or written, so a second run is a no-op rather
 * than a package install followed by a refusal.
 * @param {string} file - path to the profile's `cordis.patch.yml`.
 */
function assertNotInstalled(file) {
  const current = readFileSync(file, 'utf8')

  // The pre-0.3.2 shape, from before this package shipped a bundle layer: a
  // full `insert` row naming the package. Left in place it now composes a
  // *second* instance beside the bundle's own — two bots on one guild, every
  // command answered twice — so say exactly what to replace it with.
  //
  // Matched on the `name:` field rather than the bare package name, which also
  // appears in the comment this script writes above its own row: a substring
  // test sends a correctly-migrated profile down the migration advice.
  if (new RegExp(`^\\s*name:\\s*['"]?${PACKAGE_NAME}['"]?\\s*$`, 'm').test(current)) {
    throw new Error([
      `${file} already references ${PACKAGE_NAME}.`,
      '',
      '  If that is an `insert:` row from an older version, replace it with a config',
      '  override. The package mounts itself now, and a second insert of the same id',
      '  runs a second bot against the same guild:',
      '',
      `    - id: ${ROW_ID}`,
      '      config:',
      "        guildId: '...'        # keep the values from the old row",
      '',
      '  Then check it with: dsh --profile <name> --dump-config',
    ].join('\n'))
  }

  if (new RegExp(`^\\s*-?\\s*id:\\s*${ROW_ID}\\s*$`, 'm').test(current)) {
    throw new Error(`${file} already carries a \`${ROW_ID}\` row; edit that one instead of adding a second`)
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

  const spec = installSpec()
  process.stdout.write(`\n▸ installing ${spec} into ${profileDir}\n`)
  execFileSync('pnpm', ['add', spec], { cwd: profileDir, stdio: 'inherit' })

  if (registerBundle(profileDir)) process.stdout.write(`▸ registered the bundle in ${join(profileDir, 'package.json')}\n`)

  appendRow(patchFile, row)
  process.stdout.write(`▸ wrote the config override to ${patchFile}\n`)
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
