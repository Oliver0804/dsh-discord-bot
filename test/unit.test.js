import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isAuthorized, normalizeConfig, resolveToken } from '../lib/config.js'
import { PermissionFlagsBits } from 'discord.js'

import { channelSlug, deniesEveryone, workspaceIdFromTopic } from '../lib/topology.js'
import { displayEntry, resolveAgent, userMessage } from '../lib/run.js'
import { installApprovalAnswerer } from '../lib/approval.js'
import { listWorkspaces, suggestDirectories } from '../lib/workspaces.js'
import {
  createWorkspace,
  listSubagents,
  listWorkspaceSessions,
  readModelSelection,
  readTrajectory,
  shortId,
  switchModel,
} from '../lib/queries.js'
import {
  renderError,
  renderModel,
  renderModelSwitched,
  renderSessions,
  renderSubagents,
  renderTrajectory,
  renderWorkspaceCreated,
} from '../lib/render.js'

/**
 * A context stub. `get` is the only surface the plugin's read path uses, which
 * is what makes these modules testable without a running harness.
 * @param {Record<string, unknown>} services - services this context provides.
 * @returns {object} the stub context.
 */
const mockCtx = (services) => ({ get: (name) => services[name] })

/** Session records shaped exactly like `sessionQuery.listSessions()` returns them. */
const RECORDS = [
  { header: { id: 'session-aaaa1111-0000-0000-0000-000000000000', cwd: '/work/alpha', createdAt: '2026-08-14T00:00:00.000Z' }, live: true, persisted: true },
  { header: { id: 'session-bbbb2222-0000-0000-0000-000000000000', cwd: '/work/alpha', createdAt: '2026-08-13T00:00:00.000Z', parentSession: 'session-aaaa1111-0000-0000-0000-000000000000' }, live: false, persisted: true },
  { header: { id: 'session-cccc3333-0000-0000-0000-000000000000', cwd: '/work/beta', createdAt: '2026-08-12T00:00:00.000Z' }, live: false, persisted: true },
  { header: { id: 'session-dddd4444-0000-0000-0000-000000000000', createdAt: '2026-08-11T00:00:00.000Z' }, live: false, persisted: true },
]

const sessionQuery = {
  listSessions: async () => RECORDS,
  readTitleSnapshots: async (ids) => ids.map((id) => (String(id).startsWith('session-bbbb')
    ? { sessionId: id, status: 'rejected', reason: new Error('unreadable') }
    : { sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: `title for ${String(id).slice(8, 12)}` } } })),
  filterEvents: async () => [
    { sessionId: 's', seq: 7, type: 'user/message', time: 1786637429727, surface: 'current', text: 'research the harness' },
    { sessionId: 's', seq: 151, type: 'assistant/message', time: 1786637432204, surface: 'current', text: 'on it' },
    { sessionId: 's', seq: 152, type: 'tool/call', time: 1786637432205, surface: 'current', text: 'skill {"name":"research"}' },
    { sessionId: 's', seq: 160, type: 'session/title', time: 1786637432300, surface: 'log-only', text: 'a title' },
  ],
}

test('channel slugs are stable, legal, and non-empty', () => {
  assert.equal(channelSlug('dsh'), 'dsh')
  assert.equal(channelSlug('My Project_v2'), 'my-project-v2')
  assert.equal(channelSlug('  spaced  out  '), 'spaced-out')
  assert.equal(channelSlug('!!!'), 'workspace', 'a title of pure punctuation must still yield a legal name')
  assert.equal(channelSlug('小草之聲'), '小草之聲', 'Discord accepts unicode channel names')
  assert.ok(channelSlug('x'.repeat(200)).length <= 90)
})

test('the topic anchor round-trips and ignores unmanaged channels', () => {
  const id = 'b64551f0-701e-40e9-83fb-09ba41375e20'
  assert.equal(workspaceIdFromTopic(`[dsh:${id}] /work/alpha — /dsh sessions`), id)
  assert.equal(workspaceIdFromTopic('just a normal channel topic'), undefined)
  assert.equal(workspaceIdFromTopic(null), undefined)
  assert.equal(workspaceIdFromTopic(undefined), undefined)
})

test('config validation fills defaults and demands a real guild id', () => {
  const config = normalizeConfig({ guildId: '123456789012345678' })
  assert.equal(config.categoryName, 'dsh')
  assert.equal(config.traceLimit, 25)
  assert.equal(config.manageChannels, true)
  assert.deepEqual(config.allowedUserIds, [])

  assert.throws(() => normalizeConfig({}), /`guildId` is required/)
  assert.throws(() => normalizeConfig({ guildId: 'my-server' }), /numeric Discord snowflake/)
  assert.throws(() => normalizeConfig({ guildId: '123456789012345678', traceLimit: 0 }), /`traceLimit` must be an integer/)
  assert.throws(() => normalizeConfig({ guildId: '123456789012345678', allowedUserIds: 'me' }), /`allowedUserIds` must be a list/)
})

test('chat mode defaults to off and accepts only known triggers', () => {
  // Anything but "off" makes the bot request a privileged intent, and asking
  // for one the application has not enabled makes Discord refuse the whole
  // connection — so this field decides whether the bot can come online at all.
  const base = { guildId: '123456789012345678' }

  assert.equal(normalizeConfig(base).listenToMessages, 'off')
  assert.equal(normalizeConfig({ ...base, listenToMessages: 'mention' }).listenToMessages, 'mention')
  assert.equal(normalizeConfig({ ...base, listenToMessages: 'all' }).listenToMessages, 'all')

  assert.equal(normalizeConfig({ ...base, listenToMessages: true }).listenToMessages, 'mention',
    'a bare true takes the conservative trigger, not the loudest one')
  assert.equal(normalizeConfig({ ...base, listenToMessages: false }).listenToMessages, 'off')

  assert.throws(() => normalizeConfig({ ...base, listenToMessages: 'yes' }), /`listenToMessages` must be one of/)
  assert.throws(() => normalizeConfig({ ...base, listenToMessages: 'ALL' }), /`listenToMessages` must be one of/)
})

test('run transcripts default to minimal', () => {
  const base = { guildId: '123456789012345678' }
  assert.equal(normalizeConfig(base).runVerbosity, 'minimal', 'the common case is wanting the answer, not the transcript')
  assert.equal(normalizeConfig({ ...base, runVerbosity: 'full' }).runVerbosity, 'full')
  assert.throws(() => normalizeConfig({ ...base, runVerbosity: 'verbose' }), /`runVerbosity` must be one of/)
})

test('running work is off unless explicitly enabled', () => {
  const base = { guildId: '123456789012345678' }
  assert.equal(normalizeConfig(base).allowRun, false, 'remote execution is never a default')
  assert.equal(normalizeConfig({ ...base, allowRun: true }).allowRun, true)
  assert.throws(() => normalizeConfig({ ...base, allowRun: 'yes' }), /`allowRun` must be true or false/)
})

test('every config problem is reported in one pass', () => {
  // An operator editing YAML over SSH should learn all of it in one restart.
  assert.throws(
    () => normalizeConfig({ guildId: 'nope', traceLimit: 9999, manageChannels: 'yes' }),
    (error) => error.message.includes('guildId')
      && error.message.includes('traceLimit')
      && error.message.includes('manageChannels'),
  )
})

test('normalized config trims and drops empty optionals', () => {
  const config = normalizeConfig({ guildId: ' 123456789012345678 ', token: '  ', tokenFile: ' /tmp/t ', categoryName: '  team  ' })
  assert.equal(config.guildId, '123456789012345678')
  assert.equal(config.token, undefined, 'a whitespace token is no token')
  assert.equal(config.tokenFile, '/tmp/t')
  assert.equal(config.categoryName, 'team')
})

test('directory suggestions complete paths and match names', async () => {
  // Typing an absolute path on a phone is the reason this exists.
  const root = mkdtempSync(join(tmpdir(), 'dsh-suggest-'))
  mkdirSync(join(root, 'projects', 'alpha-tool'), { recursive: true })
  mkdirSync(join(root, 'projects', 'beta-tool'), { recursive: true })
  mkdirSync(join(root, 'projects', '.hidden'), { recursive: true })
  writeFileSync(join(root, 'projects', 'a-file.txt'), 'x')

  const known = [{ path: join(root, 'projects', 'alpha-tool') }]

  const inside = await suggestDirectories(`${join(root, 'projects')}/`, known, 25)
  assert.ok(inside.includes(join(root, 'projects', 'beta-tool')))
  assert.ok(!inside.some((path) => path.endsWith('.hidden')), 'dotfiles are noise')
  assert.ok(!inside.some((path) => path.endsWith('a-file.txt')), 'only directories are workspaces')

  const prefixed = await suggestDirectories(join(root, 'projects', 'be'), known, 25)
  assert.deepEqual(prefixed, [join(root, 'projects', 'beta-tool')], 'a partial last segment filters its parent')

  // The case from the phone: a bare name, resolved against sibling directories
  // of workspaces the harness already knows.
  const byName = await suggestDirectories('beta', known, 25)
  assert.deepEqual(byName, [join(root, 'projects', 'beta-tool')])

  assert.deepEqual(await suggestDirectories('/no/such/place/x', known, 25), [], 'an unreadable parent yields nothing, not a throw')
})

test('an externally locked category is recognized as private', () => {
  // The bot reports privacy it did not set. Calling an admin-locked category
  // "not private" would send someone chasing an exposure that does not exist;
  // the inverse would hide a real one. Both directions are checked here.
  const guild = { roles: { everyone: { id: 'everyone-role' } } }
  const withOverwrite = (deny) => ({
    permissionOverwrites: { cache: new Map([['everyone-role', { deny: { has: (bit) => bit === deny } }]]) },
  })

  assert.equal(deniesEveryone(guild, withOverwrite(PermissionFlagsBits.ViewChannel)), true)
  assert.equal(deniesEveryone(guild, withOverwrite(PermissionFlagsBits.SendMessages)), false,
    'denying something else is not privacy')
  assert.equal(deniesEveryone(guild, { permissionOverwrites: { cache: new Map() } }), false,
    'no overwrite at all means the category is open')
  assert.equal(deniesEveryone(guild, {}), false, 'a category with no overwrite manager reads as open')
})

test('an empty allowlist means the guild owner alone', () => {
  const open = { allowedUserIds: [] }
  assert.equal(isAuthorized(open, 'owner-1', 'owner-1'), true)
  assert.equal(isAuthorized(open, 'someone-else', 'owner-1'), false)
  assert.equal(isAuthorized(open, 'owner-1', undefined), false, 'an unknown owner must not authorize anyone')

  const listed = { allowedUserIds: ['a', 'b'] }
  assert.equal(isAuthorized(listed, 'b', 'owner-1'), true)
  assert.equal(isAuthorized(listed, 'owner-1', 'owner-1'), false, 'an explicit list replaces the owner default')
})

test('token resolution follows config, then file, then environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bot-'))
  const file = join(dir, 'token')
  writeFileSync(file, '# a comment\nFILE_TOKEN_VALUE\n')

  assert.equal(resolveToken({ token: 'INLINE' }), 'INLINE')
  assert.equal(resolveToken({ tokenFile: file }), 'FILE_TOKEN_VALUE')
  assert.equal(resolveToken({ tokenFile: join(dir, 'missing') }), undefined)

  writeFileSync(file, 'DISCORD_BOT_TOKEN=ENV_STYLE\n')
  assert.equal(resolveToken({ tokenFile: file }), 'ENV_STYLE', 'a KEY=value line yields the value')
})

test('workspaces fall back to cwd grouping when the registry is absent', async () => {
  const workspaces = await listWorkspaces(mockCtx({ sessionQuery }))

  assert.equal(workspaces.length, 2, 'two distinct cwds; the session without one is dropped')
  const alpha = workspaces.find((w) => w.path === '/work/alpha')
  assert.equal(alpha.title, 'alpha')
  assert.equal(alpha.synthetic, true)
  assert.deepEqual(alpha.sessionIds.map(shortId), ['aaaa1111', 'bbbb2222'])

  // The id must not change between observations, or channels lose their anchor.
  const again = await listWorkspaces(mockCtx({ sessionQuery }))
  assert.equal(again.find((w) => w.path === '/work/alpha').id, alpha.id)
})

test('the registry wins over cwd grouping when mounted', async () => {
  const registry = {
    list: () => [{
      id: 'ws-1',
      title: 'Alpha Project',
      path: '/work/alpha',
      sessionIds: ['session-aaaa1111-0000-0000-0000-000000000000'],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }],
  }

  const workspaces = await listWorkspaces(mockCtx({ sessionQuery, workspaceRegistry: registry }))
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0].id, 'ws-1')
  assert.equal(workspaces[0].synthetic, false)
})

test('session listing unions the account with cwd matches', async () => {
  const ctx = mockCtx({ sessionQuery })
  const workspace = { id: 'ws-1', title: 'Alpha', path: '/work/alpha', sessionIds: ['session-aaaa1111-0000-0000-0000-000000000000'], synthetic: false }

  const sessions = await listWorkspaceSessions(ctx, workspace, 10)

  assert.equal(sessions.length, 2, 'the unaccounted same-cwd session is still visible')
  assert.equal(sessions[0].short, 'aaaa1111')
  assert.equal(sessions[0].live, true)
  assert.equal(sessions[0].accounted, true)
  assert.equal(sessions[1].accounted, false, 'and is marked as not on the account')
  assert.equal(sessions[1].hasParent, true)
  assert.equal(sessions[1].title, undefined, 'a rejected title observation must not discard its peers')
  assert.equal(sessions[0].title, 'title for aaaa')
})

test('the title-less listing opens no logs — the autocomplete deadline path', async () => {
  let titleCalls = 0
  const counting = { ...sessionQuery, readTitleSnapshots: async (ids) => { titleCalls += 1; return sessionQuery.readTitleSnapshots(ids) } }
  const ctx = mockCtx({ sessionQuery: counting })
  const workspace = { id: 'ws-1', title: 'Alpha', path: '/work/alpha', sessionIds: [], synthetic: true }

  const light = await listWorkspaceSessions(ctx, workspace, 10, { titles: false })
  assert.equal(titleCalls, 0, 'Discord gives autocomplete three seconds; a title fold decompresses a log per session')
  assert.equal(light.length, 2)
  assert.equal(light[0].short, 'aaaa1111', 'ids and liveness still come through')
  assert.equal(light[0].live, true)
  assert.equal(light[0].title, undefined)

  await listWorkspaceSessions(ctx, workspace, 10)
  assert.equal(titleCalls, 1, 'the default still folds titles')
})

test('a trajectory keeps narrative events and takes the tail', async () => {
  const ctx = mockCtx({ sessionQuery })

  const narrative = await readTrajectory(ctx, 's', { limit: 10 })
  assert.equal(narrative.total, 3, 'session/title is not narrative')
  assert.deepEqual(narrative.entries.map((e) => e.type), ['user/message', 'assistant/message', 'tool/call'])

  const everything = await readTrajectory(ctx, 's', { limit: 10, everything: true })
  assert.equal(everything.total, 4)

  const tail = await readTrajectory(ctx, 's', { limit: 2 })
  assert.deepEqual(tail.entries.map((e) => e.seq), [151, 152], 'the newest entries survive clipping')
  assert.equal(tail.total, 3, 'total still reports everything available')
})

test('subagent entries are flattened to owned scalars', async () => {
  const subagents = {
    listChildren: async () => [
      { kind: 'child', id: 'session-1111', activity: 'running', mode: 'continuable', label: 'reviewer', hasChildren: true },
      { kind: 'diagnostic', id: 'session-2222', reason: 'corrupt' },
    ],
    listDescendants: async () => [
      { kind: 'child', id: 'session-3333', activity: 'inactive', mode: 'one-shot', hasChildren: false, depth: 2, parentId: 'session-1111' },
    ],
  }
  const ctx = mockCtx({ subagents })

  const direct = await listSubagents(ctx, 's', {})
  assert.equal(direct[0].mode, 'continuable')
  assert.equal(direct[0].hasChildren, true)
  assert.equal(direct[1].kind, 'diagnostic')
  assert.equal(direct[1].reason, 'corrupt')

  const deep = await listSubagents(ctx, 's', { deep: true })
  assert.equal(deep[0].depth, 2)
  assert.equal(deep[0].parentId, 'session-1111')
})

test('a missing service names itself instead of throwing on undefined', async () => {
  await assert.rejects(
    () => listSubagents(mockCtx({}), 's', {}),
    /`subagents` service is not mounted/,
  )
})

test('switching the model reads the write back', async () => {
  let saved = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const agentDefaultModel = {
    currentSelection: () => saved,
    saveSelection: async (selection) => { saved = selection },
  }
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [
      { id: 'deepseek-v4-flash', name: 'Flash', description: 'fast' },
      { id: 'deepseek-v4-pro', name: 'Pro', description: 'deep' },
    ],
  }
  const ctx = mockCtx({ agentDefaultModel, llm })

  const shown = await readModelSelection(ctx)
  assert.equal(shown.current.model, 'deepseek-v4-flash')
  assert.equal(shown.models.length, 2)

  const change = await switchModel(ctx, 'deepseek-v4-pro')
  assert.equal(change.before.model, 'deepseek-v4-flash')
  assert.equal(change.after.model, 'deepseek-v4-pro')
  assert.equal(change.after.provider, 'deepseek-official', 'a bare model id keeps the current provider')

  const crossed = await switchModel(ctx, 'other-provider/some-model')
  assert.equal(crossed.after.provider, 'other-provider')
  assert.equal(crossed.after.model, 'some-model')
})

test('a model switch that did not persist is reported as a failure', async () => {
  // saveSelection() is a silent no-op without a settings provider. Reporting
  // success here would leave the user believing every later session runs on a
  // model it does not.
  const frozen = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const ctx = mockCtx({ agentDefaultModel: { currentSelection: () => frozen, saveSelection: async () => {} } })

  await assert.rejects(() => switchModel(ctx, 'deepseek-v4-pro'), /no settings provider/)
})

test('an empty provider catalog does not block a switch', async () => {
  let saved = { provider: 'p', model: 'a' }
  const ctx = mockCtx({
    agentDefaultModel: { currentSelection: () => saved, saveSelection: async (s) => { saved = s } },
    llm: { listProviders: () => [{ id: 'p', name: 'P' }], listModels: async () => { throw new Error('catalog unavailable') } },
  })

  const shown = await readModelSelection(ctx)
  assert.deepEqual(shown.models, [], 'a failed catalog read is informational')

  const change = await switchModel(ctx, 'unadvertised-model')
  assert.equal(change.after.model, 'unadvertised-model', 'catalog membership is advisory in dsh')
})

test('workspace registration demands an absolute path', async () => {
  const created = []
  const registry = {
    list: () => created,
    create: async (path) => {
      const record = { id: 'ws-new', title: path.split('/').pop(), path, sessionIds: [] }
      created.push(record)
      return record
    },
  }
  const ctx = mockCtx({ workspaceRegistry: registry })

  await assert.rejects(() => createWorkspace(ctx, 'relative/dir'), /not an absolute path/)
  await assert.rejects(() => createWorkspace(ctx, '   '), /no path given/)

  const workspace = await createWorkspace(ctx, '/work/gamma')
  assert.equal(workspace.path, '/work/gamma')
  assert.equal(workspace.title, 'gamma')
  assert.equal(workspace.alreadyRegistered, false)
})

test('write-command renders are well formed', () => {
  const selection = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: [{ id: 'deepseek-v4-flash', name: 'Flash', description: 'fast' }, { id: 'deepseek-v4-pro', name: 'Pro' }],
  }
  const shown = renderModel(selection).embeds[0].toJSON()
  assert.ok(shown.description.includes('deepseek-v4-flash'))
  assert.ok(shown.fields[0].value.includes('deepseek-v4-pro'))
  assert.ok(shown.fields[0].value.length <= 1024, 'Discord caps a field value at 1024')

  const switched = renderModelSwitched({ before: { provider: 'p', model: 'a' }, after: { provider: 'p', model: 'b' } }).embeds[0].toJSON()
  assert.ok(switched.description.includes('p/b'))

  const registered = renderWorkspaceCreated({ title: 'gamma', path: '/work/gamma', sessions: 0, alreadyRegistered: false }, 'gamma').embeds[0].toJSON()
  assert.ok(registered.description.includes('/work/gamma'))
  assert.equal(registered.fields[1].value, '#gamma')

  const noChannel = renderWorkspaceCreated({ title: 'g', path: '/g', sessions: 0, alreadyRegistered: true }, undefined).embeds[0].toJSON()
  assert.ok(noChannel.title.includes('already registered'))
  assert.ok(noChannel.fields[1].value.includes('not created'))
})

test('a prompt becomes an identified frozen user message', () => {
  const message = userMessage('do the thing')

  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'do the thing' }])
  assert.deepEqual(message.source, { kind: 'user' })
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'carries a fresh uuid like the harness helper does')
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content))
  assert.notEqual(userMessage('x').id, userMessage('x').id, 'each message gets its own identity')
})

test('only human-visible events reach the live transcript', () => {
  const assistant = displayEntry({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'thinking hard' }, { type: 'text', text: 'the answer' }] } },
  })
  assert.deepEqual(assistant, { label: '🤖', text: 'the answer' }, 'reasoning is dropped, prose is kept')

  assert.deepEqual(
    displayEntry({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } }),
    { label: '🔧', text: 'bash {"command":"ls"}' },
  )

  assert.deepEqual(
    displayEntry({ type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text: 'file.txt' }] }] } } }),
    { label: '📄', text: 'file.txt' },
  )

  // The noisy majority of a real log produces nothing at all.
  assert.equal(displayEntry({ type: 'assistant/chunk', data: {} }), undefined)
  assert.equal(displayEntry({ type: 'step/start', data: {} }), undefined)
  assert.equal(displayEntry({ type: 'turn/end', data: {} }), undefined)
  assert.equal(displayEntry({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } }), undefined,
    'a reasoning-only message is not worth an edit')
})

test('a workspace with no sessions gets a fresh one, rooted at its directory', async () => {
  let created
  const agents = {
    get: () => undefined,
    resume: async () => { throw new Error('resume must not be used when there is nothing to resume') },
    create: async (options) => {
      created = options
      return { agent: { session: { id: options.sessionId } }, dispose: async () => {} }
    },
  }
  const selection = { provider: 'p', model: 'm' }
  const presets = { mount: async () => {} }
  const ctx = mockCtx({ agents, agentDefaultModel: { currentSelection: () => selection }, agentPresets: presets })
  const workspace = { id: 'ws', title: 'Gamma', path: '/work/gamma', sessionIds: [], synthetic: false }

  const agent = await resolveAgent(ctx, [], new Map(), workspace)

  assert.match(String(created.sessionId), /^session-[0-9a-f]{8}-/, 'a fresh session id is minted')
  assert.deepEqual(created.meta, { cwd: '/work/gamma' }, 'the new session is rooted in the workspace')
  assert.deepEqual(created.agentOptions, { provider: 'p', model: 'm' })
  assert.equal(typeof created.setup, 'function')
  assert.equal(String(agent.session.id), String(created.sessionId))

  // A created agent needs exactly what a resumed one needs: the model listeners
  // and the preset. Missing the preset is the failure that looks like success —
  // the agent runs and writes its tool calls as prose nobody executes.
  const installed = []
  let mountedOn
  const probe = mockCtx({
    agents,
    agentDefaultModel: { currentSelection: () => selection },
    agentPresets: { mount: async (agentCtx) => { mountedOn = agentCtx } },
  })
  await resolveAgent(probe, [], new Map(), workspace)

  const agentCtx = { on: (event) => { installed.push(event); return () => {} } }
  await created.setup(agentCtx)

  assert.deepEqual(installed.sort(), ['agent/request', 'system-prompt/assemble'])
  assert.equal(mountedOn, agentCtx, 'the preset is mounted onto the agent\'s own scope')
})

test('a created session is filed on its workspace, not left ungrouped', async () => {
  // Workspace membership is an explicit account, not something inferred from
  // cwd — skip the attach and the session shows up under "Ungrouped" in dsh
  // despite having the right directory.
  const attached = []
  const agents = {
    get: () => undefined,
    resume: async () => { throw new Error('nothing to resume') },
    create: async (options) => ({ agent: { session: { id: options.sessionId } }, dispose: async () => {} }),
  }
  const registry = { get: (id) => (id === 'ws-1' ? { attachSession: async (sid) => { attached.push(sid) } } : undefined) }
  const ctx = mockCtx({ agents, workspaceRegistry: registry })
  const workspace = { id: 'ws-1', title: 'Gamma', path: '/work/gamma', sessionIds: [], synthetic: false }

  const agent = await resolveAgent(ctx, [], new Map(), workspace)
  assert.deepEqual(attached, [String(agent.session.id)])

  // A resumed session is filed too, which repairs one that ended up unfiled.
  const resuming = mockCtx({
    agents: { ...agents, resume: async (o) => ({ agent: { session: { id: o.resumeSessionId } }, dispose: async () => {} }) },
    workspaceRegistry: registry,
  })
  await resolveAgent(resuming, [{ id: 'session-was-ungrouped' }], new Map(), workspace)
  assert.deepEqual(attached.at(-1), 'session-was-ungrouped')

  // A synthesized workspace has no record to attach to, and grouping there is
  // derived from cwd anyway.
  const before = attached.length
  const synthetic = { id: 'cwd-x', title: 'S', path: '/work/s', sessionIds: [], synthetic: true }
  await resolveAgent(ctx, [], new Map(), synthetic)
  assert.equal(attached.length, before)

  // An attach that rejects leaves the session usable rather than failing the run.
  const hostile = mockCtx({ agents, workspaceRegistry: { get: () => ({ attachSession: async () => { throw new Error('nope') } }) } })
  const survived = await resolveAgent(hostile, [], new Map(), workspace)
  assert.ok(survived.session.id, 'unfiled but usable')
})

test('a missing agents service is named, not crashed on', async () => {
  await assert.rejects(
    () => resolveAgent(mockCtx({}), [{ id: 'session-1' }], new Map(), { path: '/x' }),
    /`agents` service is not mounted/,
  )
})

test('a live agent is reused and a cold one resumed exactly once', async () => {
  const liveAgent = { session: { id: 'session-live' } }
  let resumes = 0
  const agents = {
    get: (id) => (id === 'session-live' ? liveAgent : undefined),
    resume: async ({ resumeSessionId }) => {
      resumes += 1
      return { agent: { session: { id: resumeSessionId } }, dispose: async () => {} }
    },
  }
  const ctx = mockCtx({ agents })

  const live = await resolveAgent(ctx, [{ id: 'session-cold' }, { id: 'session-live' }], new Map(), { path: "/w" })
  assert.equal(live, liveAgent, 'a live agent anywhere in the workspace wins over resuming')
  assert.equal(resumes, 0)

  const owned = new Map()
  const cold = await resolveAgent(ctx, [{ id: 'session-cold' }], owned, { path: "/w" })
  assert.equal(String(cold.session.id), 'session-cold')
  assert.equal(resumes, 1)

  await resolveAgent(ctx, [{ id: 'session-cold' }], owned, { path: "/w" })
  assert.equal(resumes, 1, 'a resumed handle is reused, not resumed again')
})

test('a resumed agent is given a model, both ways', async () => {
  // Without this the first turn dies with `prompt variable "{{model}}" has no
  // value` — the agent accepts the work and then cannot think. Routing
  // (agentOptions) and prompt assembly (the setup hook) are separate holes and
  // both have to be filled.
  let seen
  const agents = {
    get: () => undefined,
    resume: async (options) => {
      seen = options
      return { agent: { session: { id: options.resumeSessionId } }, dispose: async () => {} }
    },
  }
  const selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const ctx = mockCtx({ agents, agentDefaultModel: { currentSelection: () => selection } })

  await resolveAgent(ctx, [{ id: 'session-cold' }], new Map(), { path: "/w" })

  assert.deepEqual(seen.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.equal(typeof seen.setup, 'function', 'prompt assembly needs the setup hook')

  // The hook must install exactly the two waterfall listeners the harness's own
  // helper does, on the agent's scope context.
  const installed = []
  seen.setup({ on: (event) => { installed.push(event); return () => {} } })
  assert.deepEqual(installed.sort(), ['agent/request', 'system-prompt/assemble'])

  // And the assemble listener must actually put the model into the variables.
  const listeners = {}
  seen.setup({ on: (event, handler) => { listeners[event] = handler; return () => {} } })
  const assembled = await listeners['system-prompt/assemble']({}, {}, async () => ({ variables: { other: 1 } }))
  assert.equal(assembled.variables.model, 'deepseek-v4-flash')
  assert.equal(assembled.variables.provider, 'deepseek-official')
  assert.equal(assembled.variables.other, 1, 'existing variables survive')
})

test('a resume without a default model still works', async () => {
  let seen
  const agents = {
    get: () => undefined,
    resume: async (options) => { seen = options; return { agent: { session: { id: 'x' } }, dispose: async () => {} } },
  }

  await resolveAgent(mockCtx({ agents }), [{ id: "session-cold" }], new Map(), { path: "/w" })
  assert.equal(seen.agentOptions, undefined, 'no selection means no override, not a crash')
  seen.setup({ on: () => () => {} })
})

test('the approval answerer speaks only for its own runs', async () => {
  // The waterfall's whole point: a session the user is driving in the web UI
  // must keep being answered there. Intercepting it would move a prompt someone
  // is watching for onto a surface they are not.
  let handler
  const ctx = { get: () => undefined, on: (event, fn) => { assert.equal(event, 'approval/request'); handler = fn; return () => {} } }
  const runs = new Map()

  installApprovalAnswerer({
    ctx,
    config: { allowedUserIds: [] },
    logger: { warn() {} },
    client: () => undefined,
    runs,
  })
  assert.equal(typeof handler, 'function')

  let delegated = 0
  const next = async () => { delegated += 1; return 'delegated' }
  const request = (id) => ({ agent: { session: { id } }, toolName: 'bash' })

  assert.equal(await handler(request('session-someone-else'), next), 'delegated')
  assert.equal(delegated, 1, 'an unknown session is passed along untouched')

  // Even for our own run, an unreachable client delegates rather than guessing.
  runs.set('session-ours', { channelId: '123' })
  assert.equal(await handler(request('session-ours'), next), 'delegated')
  assert.equal(delegated, 2)

  // A malformed request must not throw into the waterfall.
  assert.equal(await handler({ toolName: 'bash' }, next), 'delegated')
  assert.equal(delegated, 3)
})

test('renders stay inside Discord embed limits and spill to a file', () => {
  const workspace = { id: 'ws-1', title: 'Alpha', path: '/work/alpha', sessionIds: [], synthetic: false }

  const sessions = Array.from({ length: 200 }, (_, i) => ({
    id: `session-${i}`, short: `s${i}`, title: 'x'.repeat(60), live: i === 0,
    createdAt: '2026-08-14T00:00:00.000Z', hasParent: false, accounted: true, total: 200,
  }))
  const listed = renderSessions(workspace, sessions)
  const listedEmbed = listed.embeds[0].toJSON()
  assert.ok(listedEmbed.description.length <= 4096, 'description within Discord limit')
  assert.equal(listed.files.length, 1, 'the full list is attached when it does not fit')

  const trajectory = {
    total: 100,
    entries: Array.from({ length: 100 }, (_, i) => ({ seq: i, type: 'user/message', time: 1786637429727, surface: 'current', text: 'y'.repeat(400) })),
  }
  const traced = renderTrajectory({ short: 'abc', title: 'T' }, trajectory)
  const tracedEmbed = traced.embeds[0].toJSON()
  assert.ok(tracedEmbed.description.length <= 4096)
  assert.equal(traced.files.length, 1)
  assert.ok(tracedEmbed.description.includes('#99'), 'the newest entry survives; the tail is what matters')
})

test('session text cannot break out of the message or ping the server', () => {
  const trajectory = {
    total: 1,
    entries: [{ seq: 1, type: 'user/message', time: 1786637429727, surface: 'current', text: '```js\nevil()\n``` @everyone' }],
  }
  const { description } = renderTrajectory({ short: 'abc', title: 'T' }, trajectory).embeds[0].toJSON()

  assert.ok(!description.includes('```'), 'code fences are neutralized')
  assert.ok(!description.includes('@everyone'), 'mentions are neutralized')
})

test('empty results render as a message rather than an empty embed', () => {
  const workspace = { id: 'ws-1', title: 'Alpha', path: '/work/alpha', sessionIds: [], synthetic: false }
  const empty = renderSessions(workspace, []).embeds[0].toJSON()
  assert.ok(empty.description.length > 0)

  const noAgents = renderSubagents({ short: 'abc' }, [], false).embeds[0].toJSON()
  assert.ok(noAgents.description.includes('no direct subagents'))

  const failed = renderError(new Error('SESSION_QUERY_CORRUPT_SESSION')).embeds[0].toJSON()
  assert.ok(failed.description.includes('SESSION_QUERY_CORRUPT_SESSION'))
})
