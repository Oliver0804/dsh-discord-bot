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
    'help.footer': 'language {language} · github.com/Oliver0804/dsh-discord-bot',

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
    'help.footer': '語言 {language} · github.com/Oliver0804/dsh-discord-bot',

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
    'help.footer': '语言 {language} · github.com/Oliver0804/dsh-discord-bot',

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
    'cmd.sessions': 'List the sessions of this channel\'s workspace.',
    'cmd.trace': 'Read a session\'s trajectory — what was said and done.',
    'cmd.timeline': 'Read a session\'s raw event timeline and type histogram.',
    'cmd.subagents': 'List a session\'s subagents and whether they are running.',
    'cmd.lineage': 'Show a session\'s ancestors and descendant sessions.',
    'cmd.run': 'Send work to this workspace\'s agent and watch it happen.',
    'cmd.model': 'Show or switch the default model for new sessions.',
    'cmd.workspace': 'Register a directory as a workspace and give it a channel.',
    'cmd.status': 'Harness overview: mounted services, sessions, mapped workspaces.',
    'cmd.sync': 'Re-sync the category and its workspace channels now.',
    'opt.session': 'Session to inspect; defaults to the newest in this workspace.',
    'opt.limitSessions': 'How many sessions to list.',
    'opt.limitTrace': 'How many trajectory entries to show.',
    'opt.limitEvents': 'How many events to show.',
    'opt.everything': 'Include non-conversational entries too.',
    'opt.deep': 'Walk the whole descendant tree, not just direct children.',
    'opt.prompt': 'What you want the agent to do.',
    'opt.to': 'Model id, or provider/model. Omit to just show the current one.',
    'opt.path': 'Directory on the harness machine — start typing a name or a path.',
  },
  'zh-Hant': {
    'cmd.root': '從 Discord 查看這個 dsh harness。',
    'cmd.help': '你可以在這裡做什麼，以及怎麼開始。',
    'cmd.sessions': '列出這個頻道所屬工作區的工作階段。',
    'cmd.trace': '讀取工作階段的軌跡 —— 說了什麼、做了什麼。',
    'cmd.timeline': '讀取工作階段的原始事件時間軸與型別統計。',
    'cmd.subagents': '列出工作階段的子代理，以及各自是否運行中。',
    'cmd.lineage': '顯示工作階段的上游與下游關係。',
    'cmd.run': '把工作送給這個工作區的代理，並即時觀看。',
    'cmd.model': '顯示或切換新工作階段的預設模型。',
    'cmd.workspace': '把一個目錄註冊成工作區並建立頻道。',
    'cmd.status': 'Harness 總覽：已掛載的服務、工作階段、已對應的工作區。',
    'cmd.sync': '立即重新同步類別與其工作區頻道。',
    'opt.session': '要查看的工作階段；預設為這個工作區最新的一個。',
    'opt.limitSessions': '要列出幾個工作階段。',
    'opt.limitTrace': '要顯示幾條軌跡。',
    'opt.limitEvents': '要顯示幾個事件。',
    'opt.everything': '連非對話性的條目也一併包含。',
    'opt.deep': '走遍整棵子孫樹，而不只是直接子代理。',
    'opt.prompt': '你希望代理做什麼。',
    'opt.to': '模型 id，或 provider/model。省略則只顯示目前的。',
    'opt.path': 'Harness 機器上的目錄 —— 開始輸入名稱或路徑。',
  },
  'zh-Hans': {
    'cmd.root': '从 Discord 查看这个 dsh harness。',
    'cmd.help': '你可以在这里做什么，以及怎么开始。',
    'cmd.sessions': '列出这个频道所属工作区的会话。',
    'cmd.trace': '读取会话的轨迹 —— 说了什么、做了什么。',
    'cmd.timeline': '读取会话的原始事件时间轴与类型统计。',
    'cmd.subagents': '列出会话的子代理，以及各自是否运行中。',
    'cmd.lineage': '显示会话的上游与下游关系。',
    'cmd.run': '把工作发给这个工作区的代理，并实时观看。',
    'cmd.model': '显示或切换新会话的默认模型。',
    'cmd.workspace': '把一个目录注册成工作区并创建频道。',
    'cmd.status': 'Harness 总览：已挂载的服务、会话、已映射的工作区。',
    'cmd.sync': '立即重新同步类别与其工作区频道。',
    'opt.session': '要查看的会话；默认为这个工作区最新的一个。',
    'opt.limitSessions': '要列出几个会话。',
    'opt.limitTrace': '要显示几条轨迹。',
    'opt.limitEvents': '要显示几个事件。',
    'opt.everything': '连非对话性的条目也一并包含。',
    'opt.deep': '走遍整棵子孙树，而不只是直接子代理。',
    'opt.prompt': '你希望代理做什么。',
    'opt.to': '模型 id，或 provider/model。省略则只显示当前的。',
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
