/**
 * User-facing text in English, Traditional Chinese and Simplified Chinese.
 *
 * Two audiences are localized differently on purpose. Command *names and
 * descriptions* go through Discord's own localization, so each person sees the
 * picker in their own client language — that is per-viewer and the bot has no
 * say in it. Command *replies* are single messages posted into a shared
 * channel, so they follow one configured language; `auto` derives it from the
 * locale of whoever invoked the command, which is the closest thing to
 * per-viewer text a channel message can be.
 *
 * Keys are dotted and grouped by surface. A missing key falls back to English
 * rather than showing a raw key: an untranslated string is a cosmetic problem,
 * a bare `sessions.empty` in a channel is a broken one.
 */

/** Languages this package ships. */
export const LANGUAGES = ['en', 'zh-Hant', 'zh-Hans']

/**
 * Map a Discord locale to one of our languages.
 *
 * Discord sends BCP-47-ish tags (`zh-TW`, `zh-CN`, `en-GB`). Only the Chinese
 * pair needs care: the script, not the region, is what a reader notices.
 *
 * @param {string | undefined} locale - Discord's locale for an interaction.
 * @returns {string} one of {@link LANGUAGES}.
 */
export function fromDiscordLocale(locale) {
  const tag = String(locale ?? '').toLowerCase()
  if (tag.startsWith('zh')) return tag.includes('cn') || tag.includes('hans') ? 'zh-Hans' : 'zh-Hant'
  return 'en'
}

/** Discord locale codes that should receive each of our languages. */
const DISCORD_LOCALES = {
  'zh-Hant': ['zh-TW'],
  'zh-Hans': ['zh-CN'],
}

const STRINGS = {
  en: {
    // Sessions
    'sessions.title': '📁 {title}',
    'sessions.empty': '_no sessions in this workspace yet_',
    'sessions.untitled': '_untitled_',
    'sessions.unlisted': '·unlisted',
    'sessions.footer': '{shown} of {total} session(s) · {path}',
      // Search
    'search.title': '🔎 {query}',
    'search.empty': '_no session in this workspace matches “{query}”_',
    'search.hit': '`{short}`{live} · {time} · `#{seq} {type}`\n{snippet}',
    'search.footer': '{count} result(s) for “{query}” · open one with /dsh trace',
    'action.trace': 'Trace',
    'action.subagents': 'Subagents',
    'action.stop': 'Stop',
    'action.timeline': 'Timeline',
    'action.todos': 'Todos',
    'action.export': 'Export',
    'action.steer': 'Steer',
    'action.confirmStop': 'Confirm stop',
    'action.cancelStop': 'Cancel',
    'action.stopConfirmHint': 'Click **Confirm stop** again to interrupt this turn.',
    'action.stopCancelled': 'Stop cancelled — the turn keeps running.',
    'modal.steerTitle': 'Steer the running turn',
    'modal.steerLabel': 'What to tell the agent now',
    'modal.steerPlaceholder': 'A short direction, delivered at the next step boundary.',
    'modal.searchTitle': 'Search this workspace',
    'modal.searchLabel': 'Query',
    'modal.searchPlaceholder': 'What are you looking for?',
    'modal.answerTitle': 'Answer the question',
    'modal.answerLabel': 'Your answer',
    'modal.answerPlaceholder': 'Type a free-form answer.',
    'question.custom': '✍️ Custom answer',
    'menu.search': 'Search',
    'menu.sync': 'Sync',


    // Trajectory
    'trace.title': '🧭 {title}',
    'trace.noText': '_no text_',
    'trace.compacted': ' ~compacted~',
    'trace.footer': 'last {shown} of {total} entries · session {short}',
    'trace.label.user': '👤 user',
    'trace.label.assistant': '🤖 assistant',
    'trace.label.tool': '🔧 tool',
    'trace.label.result': '📄 result',

    // Timeline
    'timeline.title': '⏱ {title}',
    'timeline.types': 'event types',
    'timeline.footer': 'last {shown} of {total} events · session {short}',

    // Subagents
    'subagents.title': '🧬 {title}',
    'subagents.noneDeep': '_no subagents anywhere below this session_',
    'subagents.noneDirect': '_no direct subagents_',
    'subagents.unlabelled': '_unlabelled_',
    'subagents.unreadable': 'unreadable ({reason})',
    'subagents.footer': '{count} {kind} · {running} running · session {short}',
    'subagents.kind.deep': 'descendant(s)',
    'subagents.kind.direct': 'direct child(ren)',

    // Lineage
    'lineage.title': '🌳 {title}',
    'lineage.ancestors': 'ancestors',
    'lineage.descendants': 'descendants',
    'lineage.root': '_none — this is a root session_',
    'lineage.none': '_none_',
    'lineage.complete': 'complete lineage · session {short}',
    'lineage.partial': 'partial — parent {parent} is outside the visible corpus',

    // Status
    'status.title': '🛰 dsh ↔ Discord',
    'status.blurb': 'Reaching this harness needs no inbound port: the bot dials out over the Discord gateway.',
    'status.services': 'harness services',
    'status.sessions': 'sessions',
    'status.sessionCounts': '{total} total\n{live} live',
    'status.workspaces': 'workspaces → #{category}',
    'status.workspaceRow': '• **{title}** — {count} session(s){synthetic}',
    'status.fromCwd': ' _(from cwd)_',
    'status.running': '{running} mid-turn',
    'status.footer': '{mapped} channel(s) mapped',

    // Model
    'model.title': '🧠 default model',
    'model.current': 'New sessions start on **{provider}/{model}**{effort}.\nSessions already running keep the model they were created with.',
    'model.effort': ' · effort `{effort}`',
    'model.catalog': 'models on {provider}',
    'model.noCatalog': '_this provider advertises no catalog; you can still switch by exact id_',
    'model.providers': 'providers: {providers}',
    'model.changed': '🧠 default model changed',
    'model.changedBody': '`{before}` → **{after}**',
    'model.changedFooter': 'applies to sessions created from now on; running sessions are unchanged',

    // Workspace
    'workspace.registered': '📁 workspace registered',
    'workspace.already': '📁 workspace already registered',
    'workspace.sessions': 'sessions',
    'workspace.channel': 'channel',
    'workspace.noChannel': '_not created — check the bot\'s permissions_',

    // Run
    'run.running': '⚙️ **running**',
    'run.done': '✅ **done**',
    'run.thinking': '_thinking…_',
    'run.toolCalls': '{count} tool calls',
    'run.silent': '_the agent finished without saying anything_',
    'run.toolCount': '_{count} tool call(s)_',
    'run.working': '_working…_',
    'run.starting': '_starting…_',
    'run.reading': '_reading…_',
    'run.attachedOnly': 'Look at the attached file(s): {files}',
    'run.disabled': 'running work from Discord is disabled — set `allowRun: true` in the plugin row to enable it',

    // Approval
    'approval.title': '🔐 approval needed',
    'approval.body': 'dsh wants to run **{tool}**',
    'approval.footer': 'session {short} · expires in {minutes} min',
    'approval.allow': 'Allow once',
    'approval.deny': 'Deny',
    'approval.allowed': 'allowed once by {user}',
    'approval.denied': 'denied by {user}',
    'approval.timedOut': 'no answer in time — handed back to dsh',
    'approval.notAllowed': '⛔ You are not allowed to approve dsh actions.',
    'approval.footerElsewhere': 'session {short} · started outside Discord · expires in {minutes} min',

    // Sync
    'sync.mapped': 'mapped **{count}** channel(s)',
    'sync.private': '🔒 private',
    'sync.privateExternal': '🔒 private _(set outside the bot — it cannot maintain this)_',
    'sync.notPrivate': '⚠️ **not private**',
    'sync.created': 'created {channels}',
    'sync.orphans': '{count} channel(s) map to a removed workspace',
    'sync.skipped': 'could not map {count} workspace(s)',
    'sync.invisible': '⚠️ cannot see {channels} — grant the bot **View Channel** there for chat mode',

    // Errors
    'error.title': '⚠️ query failed',
    'error.notAllowed': '⛔ You are not on this bot\'s allowlist. Ask the operator to add your user id to `allowedUserIds`.',
    'error.unmappedChannel': 'this channel is not mapped to a dsh workspace — run `/dsh sync`, or use a channel under the **{category}** category',
    'error.goneWorkspace': 'the workspace this channel maps to no longer exists in the harness',
    'error.unknownSubcommand': 'unknown subcommand `{sub}`',
    'error.searchUnavailable': 'this dsh profile has no full-text search backend — `sessionQuery` does not expose `searchSessions`',
    'error.searchEmpty': 'give me something to search for',

    'error.serviceMissing': 'the `{service}` service is not mounted in this dsh profile',
    'error.noSession': 'no session given',
    'error.ambiguousSession': '`{input}` matches {count} sessions in this workspace — use a longer prefix',
    'error.noSuchSession': 'no session in this workspace matches `{input}`',
    'error.emptyWorkspace': 'this workspace has no sessions yet',
    'error.noModel': 'no model given',
    'error.providerOnly': '`{spec}` names a provider but no model',
    'error.modelNotSaved': 'the harness accepted no model change — this dsh profile has no settings provider mounted, so the composed default stands',
    'error.noPath': 'no path given',
    'error.relativePath': '`{path}` is not an absolute path — the harness resolves nothing relative to Discord',
    'error.cannotRewind': 'nothing precedes that prompt — a session cannot be rewound to its own first turn',
    'error.notRunning': 'that session is not running right now',
    'error.rewindRunning': 'this session is running; stop the turn with `/dsh stop` before rewinding it',
    'error.noCommand': 'no command given',
    'error.noSuchCommand': 'this harness registers no command called `/{name}` — run `/dsh cmd` to see the list',
    'error.writeDisabled': 'changing this from Discord is disabled — it decides what a later turn is allowed to do, so it needs `allowRun: true` in the plugin row',
    'error.noPreset': 'no preset given',
    'error.noSuchPreset': 'no agent preset called `{id}` — run `/dsh preset` to see the roster',
    'error.brokenPreset': '`{id}` cannot compose a session ({reason}) — making it the default would break the next session created',
    'error.presetNotSaved': 'the harness accepted no preset change — this dsh profile has no settings provider mounted, so the composed default stands',
    'error.noPermission': 'no permission preset given',
    'error.noSuchPermission': 'no permission preset called `{name}` — known presets: {known}',
    'error.permissionNotSaved': 'the harness accepted no permission change — this dsh profile has no settings provider mounted, so the composed default stands',
    'error.sessionNotLive': 'session {short} is not running, so its own permission cannot be changed — only the default for new sessions can',

    // Help
    'help.title': '🛰 dsh — what you can do here',
    'help.intro': 'Each channel under **#{category}** is one dsh workspace. Run these inside a workspace channel; `session` is autocompleted and defaults to the newest one.',
    'help.reads': 'Look at what happened',
    'help.writes': 'Change things',
    'help.run': 'Make it work',
    'help.runOff': '`/dsh run` is disabled — set `allowRun: true` in the plugin row to enable it.',
    'help.chat': 'Chat mode is **{mode}** — {hint}',
    'help.mode.off': 'only `/dsh run` sends work.',
    'help.mode.mention': '@-mention the bot in a workspace channel to send work.',
    'help.mode.all': 'any message in a workspace channel is sent as work.',
    'help.mirrorOn': 'Mirror is **on** — turns started anywhere on this machine appear in their workspace channel.',
    'help.mirrorOff': 'Mirror is off — set `mirror: true` in the plugin row to watch work started outside Discord.',
    'help.footer': 'language {language} · github.com/Oliver0804/dsh-discord-bot',

    // User questions
    'question.title': '❓ question {position}/{total}',
    'question.pick': 'Choose…',
    'question.footer': 'session {short} · expires in {minutes} min',
    'question.answered': 'answered by {user}',
    'question.timedOut': 'nobody answered in time — the ask was cancelled',
    'question.withdrawn': 'the asker withdrew this question',
    'question.notAllowed': '⛔ You are not allowed to answer for this harness.',

    // Rewind
    'rewind.title': '⏪ rewind session {short}',
    'rewind.blurb': 'Pick the prompt to go back to. The conversation continues as a **new session** that stops just before it; this one is left exactly as it is.',
    'rewind.empty': '_no prompts to rewind to — nobody has asked this session anything yet_',
    'rewind.pick': 'Go back to…',
    'rewind.done': '⏪ rewound',
    'rewind.body': '`{from}` → **`{short}`**\n{kept} events kept · {dropped} dropped.',
    'rewind.footer': 'session {from} still exists, untouched',

    // Context and export
    'context.title': '🧱 what session {short} sees',
    'context.blurb': '{sections} prompt section(s) · {tools} tool(s) · {skills} skill(s), as this agent\'s own composition supplies them.',
    'context.sections': 'prompt sections',
    'context.tools': 'tools',
    'context.skills': 'skills',
    'export.title': '📄 session {short}',
    'export.body': '{entries} entries, complete, as Markdown.',

    // Steering and stopping
    'steer.title': '↪️ steered into the running turn',
    'steer.body': '_delivered at the turn\'s next step — the answer lands where that turn is being reported_',
    'steer.footer': 'session {short} · this turn was not started here',
    'stop.title': '🛑 stop',
    'stop.interrupted': 'interrupted the turn running in session `{short}`.',
    'stop.idle': 'session `{short}` was not running; nothing to interrupt.',
    'stop.footer': 'the session stays live — send work again whenever you like',
    'stop.discarded': 'queued and steering input was discarded with it',

    // Harness commands
    'harnessCmd.title': '⌨️ harness commands',
    'harnessCmd.none': '_none — this profile composes no command registry, or no session is live to read it from_',
    'harnessCmd.footer': 'run one with `/dsh cmd name:<name>`',
    'harnessCmd.ran': '⌨️ /{name}',
    'harnessCmd.failed': '⚠️ /{name} failed',
    'harnessCmd.silent': '_done — the command reported no text_',

    // Todos
    'todo.title': '☑️ {title}',
    'todo.empty': '_no todo list in this session_',
    'todo.line': '☑️ {done}/{total} · {current}',
    'todo.noneActive': '_nothing in progress_',

    // Menu card
    'menu.pickView': 'What to look at',
    'menu.pickSession': 'Which session',
    'menu.pickSetting': 'Change a setting',
    'menu.applyTo': 'Pick a {setting}',
    'menu.noSessions': 'no sessions in this workspace yet',
    'menu.refresh': 'Refresh',
    'menu.close': 'Close',
    'menu.closed': '_menu closed — run `/dsh menu` to open a new one_',
    'menu.view.sessions': 'Sessions',
    'menu.view.trace': 'Trajectory',
    'menu.view.timeline': 'Timeline',
    'menu.view.todos': 'Todo list',
    'menu.view.subagents': 'Subagents',
    'menu.view.lineage': 'Lineage',
    'menu.view.context': 'Prompt, tools, skills',
    'menu.view.status': 'Harness status',
    'menu.setting.model': 'Model',
    'menu.setting.preset': 'Agent preset',
    'menu.setting.permission': 'Permissions',

    // Mirror
    'mirror.running': '🌀 **running**',
    'mirror.done': '✅ **done**',
    'mirror.idle': '⏸ **quiet**',
    'mirror.workspace': 'workspace',
    'mirror.footer': 'session {short} · started outside Discord',
    'mirror.created': '🆕 a new session started here — `{short}`',

    // Agent preset
    'preset.title': '🧩 agent preset',
    'preset.current': 'New sessions are composed from **{id}**.\nSessions already running keep the preset they started with.',
    'preset.roster': 'available presets',
    'preset.broken': '_unusable — {reason}_',
    'preset.changed': '🧩 agent preset changed',
    'preset.footer': 'applies to sessions created from now on; running sessions are unchanged',

    // Permission preset
    'permission.title': '🔐 permissions',
    'permission.default': 'New sessions start on **{name}**.',
    'permission.session': 'Session `{short}` is running under **{current}**.\nNew sessions start on **{name}**.',
    'permission.presets': 'presets',
    'permission.footer': 'add `session:` to change one running session instead of the default',
    'permission.changedDefault': '🔐 default permission changed',
    'permission.changedSession': '🔐 session permission changed',
    'permission.scopeDefault': 'applies to sessions created from now on',
    'permission.scopeSession': 'applies to session {short} from its next tool call',

    // Session statistics strip
    'stats.line': '{turns} turns · {steps} steps | LLM {llm} · tools {tool} | TTFT {ttft} · {rate} tok/s | cache {cache} | in {input} · out {output}',

    // Shared
    'common.none': '_none_',
    'common.nothing': '_nothing to show_',
    'common.overflow': '_… {count} more line(s) — full text attached as `{file}`_',
    'common.unknownTime': '_unknown_',
  },

  'zh-Hant': {
    'sessions.title': '📁 {title}',
    'sessions.empty': '_這個工作區還沒有任何工作階段_',
    'sessions.untitled': '_未命名_',
    'sessions.unlisted': '·未登記',
    'sessions.footer': '共 {total} 個工作階段，顯示 {shown} 個 · {path}',
      // Search
    'search.title': '🔎 {query}',
    'search.empty': '_這個工作區沒有符合「{query}」的工作階段_',
    'search.hit': '`{short}`{live} · {time} · `#{seq} {type}`\n{snippet}',
    'search.footer': '「{query}」共有 {count} 筆結果 · 用 /dsh trace 開啟',
    'action.trace': '軌跡',
    'action.subagents': '子代理',
    'action.stop': '中斷',
    'action.timeline': '時間軸',
    'action.todos': '待辦',
    'action.export': '匯出',
    'action.steer': '插話',
    'action.confirmStop': '確認中斷',
    'action.cancelStop': '取消',
    'action.stopConfirmHint': '再按一次**確認中斷**才會打斷這個 turn。',
    'action.stopCancelled': '已取消中斷——turn 繼續執行。',
    'modal.steerTitle': '插話到執行中的 turn',
    'modal.steerLabel': '現在要告訴代理什麼',
    'modal.steerPlaceholder': '一句簡短指示，會在下一個步驟邊界送入。',
    'modal.searchTitle': '搜尋這個工作區',
    'modal.searchLabel': '查詢',
    'modal.searchPlaceholder': '你想找什麼？',
    'modal.answerTitle': '回答問題',
    'modal.answerLabel': '你的答案',
    'modal.answerPlaceholder': '輸入自由文字答案。',
    'question.custom': '✍️ 自行輸入',
    'menu.search': '搜尋',
    'menu.sync': '同步',


    'trace.title': '🧭 {title}',
    'trace.noText': '_無文字_',
    'trace.compacted': ' ~已壓縮~',
    'trace.footer': '共 {total} 條，顯示最後 {shown} 條 · 工作階段 {short}',
    'trace.label.user': '👤 使用者',
    'trace.label.assistant': '🤖 代理',
    'trace.label.tool': '🔧 工具',
    'trace.label.result': '📄 結果',

    'timeline.title': '⏱ {title}',
    'timeline.types': '事件型別',
    'timeline.footer': '共 {total} 個事件，顯示最後 {shown} 個 · 工作階段 {short}',

    'subagents.title': '🧬 {title}',
    'subagents.noneDeep': '_這個工作階段底下沒有任何子代理_',
    'subagents.noneDirect': '_沒有直接子代理_',
    'subagents.unlabelled': '_未命名_',
    'subagents.unreadable': '無法讀取（{reason}）',
    'subagents.footer': '{count} 個{kind} · {running} 個運行中 · 工作階段 {short}',
    'subagents.kind.deep': '子孫代理',
    'subagents.kind.direct': '直接子代理',

    'lineage.title': '🌳 {title}',
    'lineage.ancestors': '上游',
    'lineage.descendants': '下游',
    'lineage.root': '_無 —— 這是根工作階段_',
    'lineage.none': '_無_',
    'lineage.complete': '完整血緣 · 工作階段 {short}',
    'lineage.partial': '不完整 —— 上游 {parent} 不在可見範圍內',

    'status.title': '🛰 dsh ↔ Discord',
    'status.blurb': '連到這個 harness 不需要對外開通訊埠：bot 是主動從 Discord gateway 連出去的。',
    'status.services': 'harness 服務',
    'status.sessions': '工作階段',
    'status.sessionCounts': '共 {total} 個\n{live} 個運行中',
    'status.workspaces': '工作區 → #{category}',
    'status.workspaceRow': '• **{title}** —— {count} 個工作階段{synthetic}',
    'status.fromCwd': ' _（由 cwd 推導）_',
    'status.running': '{running} 個執行中',
    'status.footer': '已對應 {mapped} 個頻道',

    'model.title': '🧠 預設模型',
    'model.current': '新工作階段會使用 **{provider}/{model}**{effort}。\n已在運行的工作階段維持它建立時的模型。',
    'model.effort': ' · 推理強度 `{effort}`',
    'model.catalog': '{provider} 的模型',
    'model.noCatalog': '_這個 provider 沒有公布型錄；你仍然可以直接輸入確切的 id 來切換_',
    'model.providers': 'providers：{providers}',
    'model.changed': '🧠 預設模型已變更',
    'model.changedBody': '`{before}` → **{after}**',
    'model.changedFooter': '從現在開始建立的工作階段適用；運行中的不受影響',

    'workspace.registered': '📁 工作區已註冊',
    'workspace.already': '📁 工作區先前已註冊',
    'workspace.sessions': '工作階段',
    'workspace.channel': '頻道',
    'workspace.noChannel': '_未建立 —— 請檢查 bot 的權限_',

    'run.running': '⚙️ **執行中**',
    'run.done': '✅ **完成**',
    'run.thinking': '_思考中…_',
    'run.toolCalls': '{count} 次工具呼叫',
    'run.silent': '_代理結束了，但沒有說任何話_',
    'run.toolCount': '_{count} 次工具呼叫_',
    'run.working': '_處理中…_',
    'run.starting': '_啟動中…_',
    'run.reading': '_讀取中…_',
    'run.attachedOnly': '看一下附加的檔案：{files}',
    'run.disabled': '從 Discord 執行工作已停用 —— 在設定列加上 `allowRun: true` 才能啟用',

    'approval.title': '🔐 需要授權',
    'approval.body': 'dsh 想要執行 **{tool}**',
    'approval.footer': '工作階段 {short} · {minutes} 分鐘後逾時',
    'approval.allow': '允許一次',
    'approval.deny': '拒絕',
    'approval.allowed': '由 {user} 允許一次',
    'approval.denied': '由 {user} 拒絕',
    'approval.timedOut': '逾時未回應 —— 已交還給 dsh 決定',
    'approval.notAllowed': '⛔ 你沒有權限批准 dsh 的動作。',
    'approval.footerElsewhere': '工作階段 {short} · 由 Discord 以外的地方發起 · {minutes} 分鐘後失效',

    'sync.mapped': '已對應 **{count}** 個頻道',
    'sync.private': '🔒 私密',
    'sync.privateExternal': '🔒 私密 _（由 bot 以外設定 —— 它無法維護）_',
    'sync.notPrivate': '⚠️ **非私密**',
    'sync.created': '已建立 {channels}',
    'sync.orphans': '{count} 個頻道對應到已移除的工作區',
    'sync.skipped': '有 {count} 個工作區無法對應',
    'sync.invisible': '⚠️ 看不到 {channels} —— 請在那些頻道給 bot **查看頻道**權限才能用聊天模式',

    'error.title': '⚠️ 查詢失敗',
    'error.notAllowed': '⛔ 你不在這個 bot 的允許名單上。請管理者把你的使用者 id 加進 `allowedUserIds`。',
    'error.unmappedChannel': '這個頻道沒有對應到任何 dsh 工作區 —— 執行 `/dsh sync`，或改用 **{category}** 類別底下的頻道',
    'error.goneWorkspace': '這個頻道對應的工作區已經不存在於 harness 中',
    'error.unknownSubcommand': '未知的子指令 `{sub}`',
    'error.searchUnavailable': '這個 dsh profile 沒有全文搜尋 backend —— `sessionQuery` 沒有提供 `searchSessions`',
    'error.searchEmpty': '請輸入要搜尋的內容',

    'error.serviceMissing': '這個 dsh profile 沒有掛載 `{service}` 服務',
    'error.noSession': '沒有指定工作階段',
    'error.ambiguousSession': '`{input}` 在這個工作區對應到 {count} 個工作階段 —— 請輸入更長的前綴',
    'error.noSuchSession': '這個工作區沒有符合 `{input}` 的工作階段',
    'error.emptyWorkspace': '這個工作區還沒有任何工作階段',
    'error.noModel': '沒有指定模型',
    'error.providerOnly': '`{spec}` 只指定了 provider，沒有指定模型',
    'error.modelNotSaved': 'harness 沒有接受這次模型變更 —— 這個 dsh profile 沒有掛載 settings provider，所以維持組合設定的預設值',
    'error.noPath': '沒有指定路徑',
    'error.relativePath': '`{path}` 不是絕對路徑 —— harness 不會解析任何相對於 Discord 的路徑',
    'error.cannotRewind': '那個提示前面沒有東西 —— 工作階段無法回溯到自己的第一個 turn',
    'error.notRunning': '那個工作階段目前沒有在執行',
    'error.rewindRunning': '這個工作階段正在跑；先用 `/dsh stop` 中斷再回溯',
    'error.noCommand': '沒有指定指令',
    'error.noSuchCommand': '這個 harness 沒有註冊 `/{name}` 這個指令 —— 執行 `/dsh cmd` 可看清單',
    'error.writeDisabled': '從 Discord 改這個目前停用 —— 它決定之後的 turn 被允許做什麼，所以需要在設定列加上 `allowRun: true`',
    'error.noPreset': '沒有指定預設',
    'error.noSuchPreset': '沒有叫做 `{id}` 的 agent 預設 —— 執行 `/dsh preset` 可看清單',
    'error.brokenPreset': '`{id}` 無法組成工作階段（{reason}）—— 把它設為預設會讓下一個新工作階段直接壞掉',
    'error.presetNotSaved': 'harness 沒有接受這次預設變更 —— 這個 dsh profile 沒有掛載 settings provider，所以維持組合設定的預設值',
    'error.noPermission': '沒有指定權限模式',
    'error.noSuchPermission': '沒有叫做 `{name}` 的權限模式 —— 可用的有：{known}',
    'error.permissionNotSaved': 'harness 沒有接受這次權限變更 —— 這個 dsh profile 沒有掛載 settings provider，所以維持組合設定的預設值',
    'error.sessionNotLive': '工作階段 {short} 沒有在執行，因此無法改它自己的權限 —— 只能改新工作階段的預設值',

    'help.title': '🛰 dsh —— 你可以在這裡做什麼',
    'help.intro': '**#{category}** 底下每個頻道就是一個 dsh 工作區。以下指令請在工作區頻道內執行；`session` 有自動完成，省略時預設為最新的那一個。',
    'help.reads': '查看發生過什麼',
    'help.writes': '改變設定',
    'help.run': '讓它動手做事',
    'help.runOff': '`/dsh run` 目前停用 —— 在設定列加上 `allowRun: true` 才能啟用。',
    'help.chat': '聊天模式：**{mode}** —— {hint}',
    'help.mode.off': '只有 `/dsh run` 會派工。',
    'help.mode.mention': '在工作區頻道 @ 這個 bot 就會派工。',
    'help.mode.all': '在工作區頻道打的每一則訊息都會派工。',
    'help.mirrorOn': '自動推播**已開啟** —— 這台機器上任何地方開始的 turn 都會出現在對應的工作區頻道。',
    'help.mirrorOff': '自動推播未開啟 —— 在設定列加上 `mirror: true`，才能看到 Discord 以外發起的工作。',
    'help.footer': '語言 {language} · github.com/Oliver0804/dsh-discord-bot',

    'question.title': '❓ 問題 {position}/{total}',
    'question.pick': '選一個……',
    'question.footer': '工作階段 {short} · {minutes} 分鐘後失效',
    'question.answered': '由 {user} 回答',
    'question.timedOut': '沒有人及時回答 —— 這次詢問已取消',
    'question.withdrawn': '提問方已收回這個問題',
    'question.notAllowed': '⛔ 你沒有權限替這個 harness 回答。',

    'rewind.title': '⏪ 回溯工作階段 {short}',
    'rewind.blurb': '選一個要回到的提示。對話會以**一個新的工作階段**繼續，停在那個提示之前；原本這個完全不動。',
    'rewind.empty': '_沒有可以回溯的提示 —— 還沒有人問過這個工作階段任何事_',
    'rewind.pick': '回到……',
    'rewind.done': '⏪ 已回溯',
    'rewind.body': '`{from}` → **`{short}`**\n保留 {kept} 個事件 · 捨棄 {dropped} 個。',
    'rewind.footer': '工作階段 {from} 仍然存在，未被更動',

    'context.title': '🧱 工作階段 {short} 看得到什麼',
    'context.blurb': '{sections} 個提示區段 · {tools} 個工具 · {skills} 個技能，皆來自這個代理自己的組合。',
    'context.sections': '提示區段',
    'context.tools': '工具',
    'context.skills': '技能',
    'export.title': '📄 工作階段 {short}',
    'export.body': '{entries} 筆條目，完整內容，Markdown 格式。',

    'steer.title': '↪️ 已插入執行中的 turn',
    'steer.body': '_會在這個 turn 的下一個 step 送達 —— 結果會出現在那個 turn 被回報的地方_',
    'steer.footer': '工作階段 {short} · 這個 turn 不是從這裡開始的',
    'stop.title': '🛑 停止',
    'stop.interrupted': '已中斷工作階段 `{short}` 正在跑的 turn。',
    'stop.idle': '工作階段 `{short}` 沒有在跑，沒有東西可以中斷。',
    'stop.footer': '工作階段仍然存活 —— 隨時可以再派工',
    'stop.discarded': '排隊中與插話的輸入也一併丟棄了',

    'harnessCmd.title': '⌨️ Harness 指令',
    'harnessCmd.none': '_沒有 —— 這個 profile 沒有組合指令註冊表，或目前沒有執行中的工作階段可以讀取_',
    'harnessCmd.footer': '用 `/dsh cmd name:<名稱>` 執行',
    'harnessCmd.ran': '⌨️ /{name}',
    'harnessCmd.failed': '⚠️ /{name} 失敗',
    'harnessCmd.silent': '_完成 —— 這個指令沒有回傳文字_',

    'todo.title': '☑️ {title}',
    'todo.empty': '_這個工作階段沒有待辦清單_',
    'todo.line': '☑️ {done}/{total} · {current}',
    'todo.noneActive': '_目前沒有進行中的項目_',

    'menu.pickView': '要看什麼',
    'menu.pickSession': '選工作階段',
    'menu.pickSetting': '要改哪個設定',
    'menu.applyTo': '選一個{setting}',
    'menu.noSessions': '這個工作區還沒有工作階段',
    'menu.refresh': '重新整理',
    'menu.close': '關閉',
    'menu.closed': '_選單已關閉 —— 執行 `/dsh menu` 可以再開一張_',
    'menu.view.sessions': '工作階段',
    'menu.view.trace': '軌跡',
    'menu.view.timeline': '時間軸',
    'menu.view.todos': '待辦清單',
    'menu.view.subagents': '子代理',
    'menu.view.lineage': '親屬關係',
    'menu.view.context': '提示、工具、技能',
    'menu.view.status': 'Harness 狀態',
    'menu.setting.model': '模型',
    'menu.setting.preset': 'Agent 預設',
    'menu.setting.permission': '權限',

    'mirror.running': '🌀 **執行中**',
    'mirror.done': '✅ **完成**',
    'mirror.idle': '⏸ **靜止**',
    'mirror.workspace': '工作區',
    'mirror.footer': '工作階段 {short} · 由 Discord 以外的地方發起',
    'mirror.created': '🆕 這裡開始了一個新的工作階段 —— `{short}`',

    'preset.title': '🧩 Agent 預設',
    'preset.current': '新工作階段會以 **{id}** 組成。\n已經在跑的工作階段維持它開始時的預設。',
    'preset.roster': '可用的預設',
    'preset.broken': '_無法使用 —— {reason}_',
    'preset.changed': '🧩 Agent 預設已變更',
    'preset.footer': '對此後新建的工作階段生效；執行中的不受影響',

    'permission.title': '🔐 權限',
    'permission.default': '新工作階段會以 **{name}** 開始。',
    'permission.session': '工作階段 `{short}` 目前執行於 **{current}**。\n新工作階段會以 **{name}** 開始。',
    'permission.presets': '權限模式',
    'permission.footer': '加上 `session:` 可改某個執行中的工作階段，而不是改預設值',
    'permission.changedDefault': '🔐 預設權限已變更',
    'permission.changedSession': '🔐 工作階段權限已變更',
    'permission.scopeDefault': '對此後新建的工作階段生效',
    'permission.scopeSession': '從工作階段 {short} 的下一次工具呼叫起生效',

    'stats.line': '{turns} 輪 · {steps} 步 | LLM {llm} · 工具 {tool} | 首字 {ttft} · {rate} tok/s | 快取 {cache} | 輸入 {input} · 輸出 {output}',

    'common.none': '_無_',
    'common.nothing': '_沒有內容_',
    'common.overflow': '_… 還有 {count} 行 —— 完整內容見附件 `{file}`_',
    'common.unknownTime': '_未知_',
  },

  'zh-Hans': {
    'sessions.title': '📁 {title}',
    'sessions.empty': '_这个工作区还没有任何会话_',
    'sessions.untitled': '_未命名_',
    'sessions.unlisted': '·未登记',
    'sessions.footer': '共 {total} 个会话，显示 {shown} 个 · {path}',
      // Search
    'search.title': '🔎 {query}',
    'search.empty': '_这个工作区没有符合「{query}」的会话_',
    'search.hit': '`{short}`{live} · {time} · `#{seq} {type}`\n{snippet}',
    'search.footer': '「{query}」共有 {count} 条结果 · 用 /dsh trace 打开',
    'action.trace': '轨迹',
    'action.subagents': '子代理',
    'action.stop': '中断',
    'action.timeline': '时间轴',
    'action.todos': '待办',
    'action.export': '导出',
    'action.steer': '插话',
    'action.confirmStop': '确认中断',
    'action.cancelStop': '取消',
    'action.stopConfirmHint': '再按一次**确认中断**才会打断这个 turn。',
    'action.stopCancelled': '已取消中断——turn 继续执行。',
    'modal.steerTitle': '插话到执行中的 turn',
    'modal.steerLabel': '现在要告诉代理什么',
    'modal.steerPlaceholder': '一句简短指示，会在下一个步骤边界送入。',
    'modal.searchTitle': '搜索这个工作区',
    'modal.searchLabel': '查询',
    'modal.searchPlaceholder': '你想找什么？',
    'modal.answerTitle': '回答问题',
    'modal.answerLabel': '你的答案',
    'modal.answerPlaceholder': '输入自由文字答案。',
    'question.custom': '✍️ 自行输入',
    'menu.search': '搜索',
    'menu.sync': '同步',


    'trace.title': '🧭 {title}',
    'trace.noText': '_无文字_',
    'trace.compacted': ' ~已压缩~',
    'trace.footer': '共 {total} 条，显示最后 {shown} 条 · 会话 {short}',
    'trace.label.user': '👤 用户',
    'trace.label.assistant': '🤖 代理',
    'trace.label.tool': '🔧 工具',
    'trace.label.result': '📄 结果',

    'timeline.title': '⏱ {title}',
    'timeline.types': '事件类型',
    'timeline.footer': '共 {total} 个事件，显示最后 {shown} 个 · 会话 {short}',

    'subagents.title': '🧬 {title}',
    'subagents.noneDeep': '_这个会话下面没有任何子代理_',
    'subagents.noneDirect': '_没有直接子代理_',
    'subagents.unlabelled': '_未命名_',
    'subagents.unreadable': '无法读取（{reason}）',
    'subagents.footer': '{count} 个{kind} · {running} 个运行中 · 会话 {short}',
    'subagents.kind.deep': '子孙代理',
    'subagents.kind.direct': '直接子代理',

    'lineage.title': '🌳 {title}',
    'lineage.ancestors': '上游',
    'lineage.descendants': '下游',
    'lineage.root': '_无 —— 这是根会话_',
    'lineage.none': '_无_',
    'lineage.complete': '完整血缘 · 会话 {short}',
    'lineage.partial': '不完整 —— 上游 {parent} 不在可见范围内',

    'status.title': '🛰 dsh ↔ Discord',
    'status.blurb': '连到这个 harness 不需要对外开端口：bot 是主动从 Discord gateway 连出去的。',
    'status.services': 'harness 服务',
    'status.sessions': '会话',
    'status.sessionCounts': '共 {total} 个\n{live} 个运行中',
    'status.workspaces': '工作区 → #{category}',
    'status.workspaceRow': '• **{title}** —— {count} 个会话{synthetic}',
    'status.fromCwd': ' _（由 cwd 推导）_',
    'status.running': '{running} 个运行中',
    'status.footer': '已映射 {mapped} 个频道',

    'model.title': '🧠 默认模型',
    'model.current': '新会话会使用 **{provider}/{model}**{effort}。\n已在运行的会话保持它创建时的模型。',
    'model.effort': ' · 推理强度 `{effort}`',
    'model.catalog': '{provider} 的模型',
    'model.noCatalog': '_这个 provider 没有公布目录；你仍然可以直接输入确切的 id 来切换_',
    'model.providers': 'providers：{providers}',
    'model.changed': '🧠 默认模型已变更',
    'model.changedBody': '`{before}` → **{after}**',
    'model.changedFooter': '从现在开始创建的会话适用；运行中的不受影响',

    'workspace.registered': '📁 工作区已注册',
    'workspace.already': '📁 工作区此前已注册',
    'workspace.sessions': '会话',
    'workspace.channel': '频道',
    'workspace.noChannel': '_未创建 —— 请检查 bot 的权限_',

    'run.running': '⚙️ **执行中**',
    'run.done': '✅ **完成**',
    'run.thinking': '_思考中…_',
    'run.toolCalls': '{count} 次工具调用',
    'run.silent': '_代理结束了，但没有说任何话_',
    'run.toolCount': '_{count} 次工具调用_',
    'run.working': '_处理中…_',
    'run.starting': '_启动中…_',
    'run.reading': '_读取中…_',
    'run.attachedOnly': '看一下附加的文件：{files}',
    'run.disabled': '从 Discord 执行工作已停用 —— 在配置行加上 `allowRun: true` 才能启用',

    'approval.title': '🔐 需要授权',
    'approval.body': 'dsh 想要执行 **{tool}**',
    'approval.footer': '会话 {short} · {minutes} 分钟后超时',
    'approval.allow': '允许一次',
    'approval.deny': '拒绝',
    'approval.allowed': '由 {user} 允许一次',
    'approval.denied': '由 {user} 拒绝',
    'approval.timedOut': '超时未回应 —— 已交还给 dsh 决定',
    'approval.notAllowed': '⛔ 你没有权限批准 dsh 的操作。',
    'approval.footerElsewhere': '会话 {short} · 由 Discord 以外的地方发起 · {minutes} 分钟后失效',

    'sync.mapped': '已映射 **{count}** 个频道',
    'sync.private': '🔒 私密',
    'sync.privateExternal': '🔒 私密 _（由 bot 以外设置 —— 它无法维护）_',
    'sync.notPrivate': '⚠️ **非私密**',
    'sync.created': '已创建 {channels}',
    'sync.orphans': '{count} 个频道映射到已移除的工作区',
    'sync.skipped': '有 {count} 个工作区无法映射',
    'sync.invisible': '⚠️ 看不到 {channels} —— 请在那些频道给 bot **查看频道**权限才能用聊天模式',

    'error.title': '⚠️ 查询失败',
    'error.notAllowed': '⛔ 你不在这个 bot 的允许名单上。请管理员把你的用户 id 加进 `allowedUserIds`。',
    'error.unmappedChannel': '这个频道没有映射到任何 dsh 工作区 —— 执行 `/dsh sync`，或改用 **{category}** 类别下的频道',
    'error.goneWorkspace': '这个频道映射的工作区已经不存在于 harness 中',
    'error.unknownSubcommand': '未知的子命令 `{sub}`',
    'error.searchUnavailable': '这个 dsh profile 没有全文搜索后端 —— `sessionQuery` 没有提供 `searchSessions`',
    'error.searchEmpty': '请输入要搜索的内容',

    'error.serviceMissing': '这个 dsh profile 没有挂载 `{service}` 服务',
    'error.noSession': '没有指定会话',
    'error.ambiguousSession': '`{input}` 在这个工作区对应到 {count} 个会话 —— 请输入更长的前缀',
    'error.noSuchSession': '这个工作区没有匹配 `{input}` 的会话',
    'error.emptyWorkspace': '这个工作区还没有任何会话',
    'error.noModel': '没有指定模型',
    'error.providerOnly': '`{spec}` 只指定了 provider，没有指定模型',
    'error.modelNotSaved': 'harness 没有接受这次模型变更 —— 这个 dsh profile 没有挂载 settings provider，所以保持组合配置的默认值',
    'error.noPath': '没有指定路径',
    'error.relativePath': '`{path}` 不是绝对路径 —— harness 不会解析任何相对于 Discord 的路径',
    'error.cannotRewind': '那个提示前面没有东西 —— 会话无法回溯到自己的第一个 turn',
    'error.notRunning': '那个会话目前没有在执行',
    'error.rewindRunning': '这个会话正在跑；先用 `/dsh stop` 中断再回溯',
    'error.noCommand': '没有指定命令',
    'error.noSuchCommand': '这个 harness 没有注册 `/{name}` 这个命令 —— 执行 `/dsh cmd` 可查看清单',
    'error.writeDisabled': '从 Discord 改这个目前已停用 —— 它决定之后的 turn 被允许做什么，所以需要在配置行加上 `allowRun: true`',
    'error.noPreset': '没有指定预设',
    'error.noSuchPreset': '没有叫做 `{id}` 的 agent 预设 —— 执行 `/dsh preset` 可查看清单',
    'error.brokenPreset': '`{id}` 无法组成会话（{reason}）—— 把它设为默认会让下一个新会话直接坏掉',
    'error.presetNotSaved': 'harness 没有接受这次预设变更 —— 这个 dsh profile 没有挂载 settings provider，所以维持组合配置的默认值',
    'error.noPermission': '没有指定权限模式',
    'error.noSuchPermission': '没有叫做 `{name}` 的权限模式 —— 可用的有：{known}',
    'error.permissionNotSaved': 'harness 没有接受这次权限变更 —— 这个 dsh profile 没有挂载 settings provider，所以维持组合配置的默认值',
    'error.sessionNotLive': '会话 {short} 没有在运行，因此无法改它自己的权限 —— 只能改新会话的默认值',

    'help.title': '🛰 dsh —— 你可以在这里做什么',
    'help.intro': '**#{category}** 下面每个频道就是一个 dsh 工作区。以下命令请在工作区频道内执行；`session` 有自动完成，省略时默认为最新的那一个。',
    'help.reads': '查看发生过什么',
    'help.writes': '改变配置',
    'help.run': '让它动手做事',
    'help.runOff': '`/dsh run` 当前停用 —— 在配置行加上 `allowRun: true` 才能启用。',
    'help.chat': '聊天模式：**{mode}** —— {hint}',
    'help.mode.off': '只有 `/dsh run` 会派工。',
    'help.mode.mention': '在工作区频道 @ 这个 bot 就会派工。',
    'help.mode.all': '在工作区频道发的每一条消息都会派工。',
    'help.mirrorOn': '自动推送**已开启** —— 这台机器上任何地方开始的 turn 都会出现在对应的工作区频道。',
    'help.mirrorOff': '自动推送未开启 —— 在配置行加上 `mirror: true`，才能看到 Discord 以外发起的工作。',
    'help.footer': '语言 {language} · github.com/Oliver0804/dsh-discord-bot',

    'question.title': '❓ 问题 {position}/{total}',
    'question.pick': '选一个……',
    'question.footer': '会话 {short} · {minutes} 分钟后失效',
    'question.answered': '由 {user} 回答',
    'question.timedOut': '没有人及时回答 —— 这次询问已取消',
    'question.withdrawn': '提问方已收回这个问题',
    'question.notAllowed': '⛔ 你没有权限替这个 harness 回答。',

    'rewind.title': '⏪ 回溯会话 {short}',
    'rewind.blurb': '选一个要回到的提示。对话会以**一个新会话**继续，停在那个提示之前；原本这个完全不动。',
    'rewind.empty': '_没有可以回溯的提示 —— 还没有人问过这个会话任何事_',
    'rewind.pick': '回到……',
    'rewind.done': '⏪ 已回溯',
    'rewind.body': '`{from}` → **`{short}`**\n保留 {kept} 个事件 · 舍弃 {dropped} 个。',
    'rewind.footer': '会话 {from} 仍然存在，未被改动',

    'context.title': '🧱 会话 {short} 看得到什么',
    'context.blurb': '{sections} 个提示段 · {tools} 个工具 · {skills} 个技能，均来自这个代理自己的组合。',
    'context.sections': '提示段',
    'context.tools': '工具',
    'context.skills': '技能',
    'export.title': '📄 会话 {short}',
    'export.body': '{entries} 条条目，完整内容，Markdown 格式。',

    'steer.title': '↪️ 已插入运行中的 turn',
    'steer.body': '_会在这个 turn 的下一个 step 送达 —— 结果会出现在那个 turn 被报告的地方_',
    'steer.footer': '会话 {short} · 这个 turn 不是从这里开始的',
    'stop.title': '🛑 停止',
    'stop.interrupted': '已中断会话 `{short}` 正在跑的 turn。',
    'stop.idle': '会话 `{short}` 没有在跑，没有东西可以中断。',
    'stop.footer': '会话仍然存活 —— 随时可以再派工',
    'stop.discarded': '排队中与插话的输入也一并丢弃了',

    'harnessCmd.title': '⌨️ Harness 命令',
    'harnessCmd.none': '_没有 —— 这个 profile 没有组合命令注册表，或当前没有运行中的会话可以读取_',
    'harnessCmd.footer': '用 `/dsh cmd name:<名称>` 执行',
    'harnessCmd.ran': '⌨️ /{name}',
    'harnessCmd.failed': '⚠️ /{name} 失败',
    'harnessCmd.silent': '_完成 —— 这个命令没有返回文本_',

    'todo.title': '☑️ {title}',
    'todo.empty': '_这个会话没有待办清单_',
    'todo.line': '☑️ {done}/{total} · {current}',
    'todo.noneActive': '_当前没有进行中的项目_',

    'menu.pickView': '要看什么',
    'menu.pickSession': '选会话',
    'menu.pickSetting': '要改哪个设置',
    'menu.applyTo': '选一个{setting}',
    'menu.noSessions': '这个工作区还没有会话',
    'menu.refresh': '刷新',
    'menu.close': '关闭',
    'menu.closed': '_菜单已关闭 —— 执行 `/dsh menu` 可以再开一张_',
    'menu.view.sessions': '会话',
    'menu.view.trace': '轨迹',
    'menu.view.timeline': '时间轴',
    'menu.view.todos': '待办清单',
    'menu.view.subagents': '子代理',
    'menu.view.lineage': '亲属关系',
    'menu.view.context': '提示、工具、技能',
    'menu.view.status': 'Harness 状态',
    'menu.setting.model': '模型',
    'menu.setting.preset': 'Agent 预设',
    'menu.setting.permission': '权限',

    'mirror.running': '🌀 **运行中**',
    'mirror.done': '✅ **完成**',
    'mirror.idle': '⏸ **静止**',
    'mirror.workspace': '工作区',
    'mirror.footer': '会话 {short} · 由 Discord 以外的地方发起',
    'mirror.created': '🆕 这里开始了一个新会话 —— `{short}`',

    'preset.title': '🧩 Agent 预设',
    'preset.current': '新会话会以 **{id}** 组成。\n已经在跑的会话保持它开始时的预设。',
    'preset.roster': '可用的预设',
    'preset.broken': '_无法使用 —— {reason}_',
    'preset.changed': '🧩 Agent 预设已变更',
    'preset.footer': '对此后新建的会话生效；运行中的不受影响',

    'permission.title': '🔐 权限',
    'permission.default': '新会话会以 **{name}** 开始。',
    'permission.session': '会话 `{short}` 当前运行于 **{current}**。\n新会话会以 **{name}** 开始。',
    'permission.presets': '权限模式',
    'permission.footer': '加上 `session:` 可改某个运行中的会话，而不是改默认值',
    'permission.changedDefault': '🔐 默认权限已变更',
    'permission.changedSession': '🔐 会话权限已变更',
    'permission.scopeDefault': '对此后新建的会话生效',
    'permission.scopeSession': '从会话 {short} 的下一次工具调用起生效',

    'stats.line': '{turns} 轮 · {steps} 步 | LLM {llm} · 工具 {tool} | 首字 {ttft} · {rate} tok/s | 缓存 {cache} | 输入 {input} · 输出 {output}',

    'common.none': '_无_',
    'common.nothing': '_没有内容_',
    'common.overflow': '_… 还有 {count} 行 —— 完整内容见附件 `{file}`_',
    'common.unknownTime': '_未知_',
  },
}

/**
 * Substitute `{name}` placeholders.
 * @param {string} template - the string to fill.
 * @param {object} params - values by placeholder name.
 * @returns {string} the filled string.
 */
function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole))
}

/**
 * Build a translator.
 * @param {string} language - a configured language, or `auto`.
 * @param {string} [locale] - the invoking user's Discord locale, used when `auto`.
 * @returns {(key: string, params?: object) => string} the translator.
 */
export function translator(language, locale) {
  const lang = language === 'auto' ? fromDiscordLocale(locale) : language
  const table = STRINGS[lang] ?? STRINGS.en

  const t = (key, params = {}) => fill(table[key] ?? STRINGS.en[key] ?? key, params)
  // Exposed so a renderer can reach the command tables, which are keyed by
  // language rather than going through the reply strings.
  t.lang = LANGUAGES.includes(lang) ? lang : 'en'
  return t
}

/**
 * An error that knows which string it is, not just how it reads in English.
 *
 * Thrown deep in the query layer, which has no idea who is asking, and
 * translated at the surface that does. The `message` stays English so logs and
 * issue reports remain searchable in one language, while the reply is rendered
 * in the reader's.
 */
export class TranslatableError extends Error {
  /**
   * @param {string} key - a string key.
   * @param {object} [params] - placeholder values.
   */
  constructor(key, params = {}) {
    super(translator('en')(key, params))
    this.name = 'TranslatableError'
    this.key = key
    this.params = params
  }
}

/**
 * A translator for a surface with no interacting human: the mirror, an approval
 * card for a session started elsewhere, a question the model asked.
 *
 * `auto` means "follow whoever invoked this", and these surfaces have nobody to
 * follow. The guild's own preferred locale is the closest stand-in — a server
 * whose members read Chinese says so — and it is read on each call rather than
 * captured, because the bot builds these before it has connected to Discord at
 * all. An operator who wants one fixed language sets `language` explicitly and
 * this resolves to it regardless.
 *
 * @param {object} config - the validated plugin config.
 * @param {() => string | undefined} [resolveLocale] - the guild's locale, when known.
 * @returns {(key: string, params?: object) => string} the translator.
 */
export function ambientTranslator(config, resolveLocale) {
  let cached

  const translate = (key, params) => {
    const locale = resolveLocale?.()
    if (cached === undefined || cached.locale !== locale) {
      cached = { locale, fn: translator(config.language, locale) }
    }
    return cached.fn(key, params)
  }

  Object.defineProperty(translate, 'lang', { get: () => cached?.fn.lang ?? 'en' })
  return translate
}

/**
 * The `*_localizations` map Discord expects for one key, so the command picker
 * renders in each viewer's own client language regardless of `language`.
 * @param {string} key - a string key present in every table.
 * @returns {object} Discord locale to translated string.
 */
export function discordLocalizations(key) {
  const map = {}
  for (const [lang, locales] of Object.entries(DISCORD_LOCALES)) {
    const value = STRINGS[lang]?.[key]
    if (value === undefined) continue
    for (const locale of locales) map[locale] = value
  }
  return map
}

/**
 * Register command name/description strings for Discord's own localization.
 * Kept separate from the reply tables because these have hard length limits
 * and a different audience: the picker, not the channel.
 */
export const COMMANDS = {
  en: {
    'cmd.root': 'Inspect this dsh harness from Discord.',
    'cmd.help': 'What you can do here, and how to start.',
    'cmd.menu': 'Open a card whose dropdowns do everything below, without typing.',
    'cmd.sessions': 'List the sessions of this channel\'s workspace.',
    'cmd.search': 'Search this workspace\'s sessions by text.',
    'cmd.trace': 'Read a session\'s trajectory — what was said and done.',
    'cmd.timeline': 'Read a session\'s raw event timeline and type histogram.',
    'cmd.subagents': 'List a session\'s subagents and whether they are running.',
    'cmd.lineage': 'Show a session\'s ancestors and descendant sessions.',
    'cmd.run': 'Send work to this workspace\'s agent and watch it happen.',
    'cmd.model': 'Show or switch the default model for new sessions.',
    'cmd.todos': 'Show the todo list a running session is working through.',
    'cmd.stop': 'Interrupt the turn a session is running right now.',
    'cmd.rewind': 'Continue a session from an earlier prompt, in a new session.',
    'cmd.context': 'Show the prompt sections, tools and skills a running session has.',
    'cmd.export': 'Export a session\'s whole trajectory as a Markdown file.',
    'cmd.cmd': 'List or run this harness\'s own commands (/compact, /plan, …).',
    'cmd.preset': 'Show or switch the agent preset new sessions are composed from.',
    'cmd.permission': 'Show or switch permissions: the default, or one running session.',
    'cmd.workspace': 'Register a directory as a workspace and give it a channel.',
    'cmd.status': 'Harness overview: mounted services, sessions, mapped workspaces.',
    'cmd.sync': 'Re-sync the category and its workspace channels now.',
    'opt.session': 'Session to inspect; defaults to the newest in this workspace.',
    'opt.limitSessions': 'How many sessions to list.',
    'opt.query': 'What to search for.',
    'opt.limitSearch': 'How many results to show.',
    'opt.limitTrace': 'How many trajectory entries to show.',
    'opt.limitEvents': 'How many events to show.',
    'opt.everything': 'Include non-conversational entries too.',
    'opt.deep': 'Walk the whole descendant tree, not just direct children.',
    'opt.prompt': 'What you want the agent to do.',
    'opt.to': 'Model id, or provider/model. Omit to just show the current one.',
    'opt.cmdName': 'Harness command to run. Omit to just list what this deployment has.',
    'opt.cmdInput': 'Text passed to the command, exactly as you would type after its name.',
    'opt.presetTo': 'Preset id. Omit to just show the current one and the roster.',
    'opt.permissionTo': 'Permission preset. Omit to just show what is in force.',
    'opt.sessionLive': 'Running session to change, instead of the default for new ones.',
    'opt.path': 'Directory on the harness machine — start typing a name or a path.',
  },
  'zh-Hant': {
    'cmd.root': '從 Discord 查看這個 dsh harness。',
    'cmd.help': '你可以在這裡做什麼，以及怎麼開始。',
    'cmd.menu': '開一張卡片，用下拉選單完成以下所有操作，不必再打字。',
    'cmd.sessions': '列出這個頻道所屬工作區的工作階段。',
    'cmd.search': '以文字搜尋這個工作區的工作階段。',
    'cmd.trace': '讀取工作階段的軌跡 —— 說了什麼、做了什麼。',
    'cmd.timeline': '讀取工作階段的原始事件時間軸與型別統計。',
    'cmd.subagents': '列出工作階段的子代理，以及各自是否運行中。',
    'cmd.lineage': '顯示工作階段的上游與下游關係。',
    'cmd.run': '把工作送給這個工作區的代理，並即時觀看。',
    'cmd.model': '顯示或切換新工作階段的預設模型。',
    'cmd.todos': '顯示執行中工作階段正在跑的待辦清單。',
    'cmd.stop': '中斷某個工作階段現在正在跑的 turn。',
    'cmd.rewind': '從較早的提示接續一個工作階段，開成新的工作階段。',
    'cmd.context': '顯示執行中工作階段擁有的提示區段、工具與技能。',
    'cmd.export': '把工作階段的完整軌跡匯出成 Markdown 檔。',
    'cmd.cmd': '列出或執行這個 harness 自己的指令（/compact、/plan…）。',
    'cmd.preset': '顯示或切換新工作階段使用的 Agent 預設。',
    'cmd.permission': '顯示或切換權限：新工作階段的預設，或某個執行中的工作階段。',
    'cmd.workspace': '把一個目錄註冊成工作區並建立頻道。',
    'cmd.status': 'Harness 總覽：已掛載的服務、工作階段、已對應的工作區。',
    'cmd.sync': '立即重新同步類別與其工作區頻道。',
    'opt.session': '要查看的工作階段；預設為這個工作區最新的一個。',
    'opt.limitSessions': '要列出幾個工作階段。',
    'opt.query': '要搜尋什麼。',
    'opt.limitSearch': '要顯示幾筆結果。',
    'opt.limitTrace': '要顯示幾條軌跡。',
    'opt.limitEvents': '要顯示幾個事件。',
    'opt.everything': '連非對話性的條目也一併包含。',
    'opt.deep': '走遍整棵子孫樹，而不只是直接子代理。',
    'opt.prompt': '你希望代理做什麼。',
    'opt.to': '模型 id，或 provider/model。省略則只顯示目前的。',
    'opt.cmdName': '要執行的 harness 指令。省略則只列出這個部署有哪些。',
    'opt.cmdInput': '傳給該指令的文字，就跟你在名稱後面打的一樣。',
    'opt.presetTo': '預設 id。省略則只顯示目前的預設與清單。',
    'opt.permissionTo': '權限模式。省略則只顯示目前生效的。',
    'opt.sessionLive': '要改的執行中工作階段；不指定則改新工作階段的預設值。',
    'opt.path': 'Harness 機器上的目錄 —— 開始輸入名稱或路徑。',
  },
  'zh-Hans': {
    'cmd.root': '从 Discord 查看这个 dsh harness。',
    'cmd.help': '你可以在这里做什么，以及怎么开始。',
    'cmd.menu': '打开一张卡片，用下拉菜单完成以下所有操作，不必再打字。',
    'cmd.sessions': '列出这个频道所属工作区的会话。',
    'cmd.search': '用文字搜索这个工作区的会话。',
    'cmd.trace': '读取会话的轨迹 —— 说了什么、做了什么。',
    'cmd.timeline': '读取会话的原始事件时间轴与类型统计。',
    'cmd.subagents': '列出会话的子代理，以及各自是否运行中。',
    'cmd.lineage': '显示会话的上游与下游关系。',
    'cmd.run': '把工作发给这个工作区的代理，并实时观看。',
    'cmd.model': '显示或切换新会话的默认模型。',
    'cmd.todos': '显示运行中会话正在跑的待办清单。',
    'cmd.stop': '中断某个会话当前正在跑的 turn。',
    'cmd.rewind': '从较早的提示接续一个会话，开成新的会话。',
    'cmd.context': '显示运行中会话拥有的提示段、工具与技能。',
    'cmd.export': '把会话的完整轨迹导出成 Markdown 文件。',
    'cmd.cmd': '列出或执行这个 harness 自己的命令（/compact、/plan…）。',
    'cmd.preset': '显示或切换新会话使用的 Agent 预设。',
    'cmd.permission': '显示或切换权限：新会话的默认值，或某个运行中的会话。',
    'cmd.workspace': '把一个目录注册成工作区并创建频道。',
    'cmd.status': 'Harness 总览：已挂载的服务、会话、已映射的工作区。',
    'cmd.sync': '立即重新同步类别与其工作区频道。',
    'opt.session': '要查看的会话；默认为这个工作区最新的一个。',
    'opt.limitSessions': '要列出几个会话。',
    'opt.query': '要搜索什么。',
    'opt.limitSearch': '要显示几条结果。',
    'opt.limitTrace': '要显示几条轨迹。',
    'opt.limitEvents': '要显示几个事件。',
    'opt.everything': '连非对话性的条目也一并包含。',
    'opt.deep': '走遍整棵子孙树，而不只是直接子代理。',
    'opt.prompt': '你希望代理做什么。',
    'opt.to': '模型 id，或 provider/model。省略则只显示当前的。',
    'opt.cmdName': '要执行的 harness 命令。省略则只列出这个部署有哪些。',
    'opt.cmdInput': '传给该命令的文本，就跟你在名称后面打的一样。',
    'opt.presetTo': '预设 id。省略则只显示当前的预设与清单。',
    'opt.permissionTo': '权限模式。省略则只显示当前生效的。',
    'opt.sessionLive': '要改的运行中会话；不指定则改新会话的默认值。',
    'opt.path': 'Harness 机器上的目录 —— 开始输入名称或路径。',
  },
}

/**
 * English text and its localizations for one command string, ready to spread
 * into a discord.js builder.
 * @param {string} key - a `cmd.*` or `opt.*` key.
 * @returns {{value: string, localizations: object}} the description and its map.
 */
export function commandText(key) {
  const localizations = {}
  for (const [lang, locales] of Object.entries(DISCORD_LOCALES)) {
    const value = COMMANDS[lang]?.[key]
    if (value === undefined) continue
    for (const locale of locales) localizations[locale] = value
  }
  return { value: COMMANDS.en[key] ?? key, localizations }
}
