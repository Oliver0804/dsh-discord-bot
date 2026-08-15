# dsh-discord-bot × dsh：尚未整合的能力盤點

> 產出方式：對**執行中的 harness**（`0.1.0-rc.6`，web profile）用 Inspect Provider 列舉
> 全部 Service 與 Event 契約，再與本 plugin 實際使用的介面逐一比對。以下每個建議都附
> 真實 API 名稱與做法，不是猜測。
>
> 日期：2026-08-15（以當時的 dsh rc.6 catalog 為準；API 可能隨版本演進，落地前請重新查證）

---

## 一、目前已接的 harness 表面

| harness 介面 | 用在 plugin 哪裡 |
|---|---|
| `sessionQuery.listSessions` / `readTitleSnapshots` | `/dsh sessions`、自動完成、workspace 歸屬判斷 |
| `sessionQuery.filterEvents` | `/dsh trace`（用 harness 自己的語意文件投影） |
| `sessionQuery.listEvents` | `/dsh timeline` |
| `sessionQuery.traceSession` | `/dsh lineage` |
| `workspaceRegistry.list` / `create` | `/dsh workspace`、頻道對應（`lib/workspaces.js`） |
| `subagents.listChildren` / `listDescendants` | `/dsh subagents` |
| `agentDefaultModel.currentSelection` / `saveSelection` | `/dsh model` |
| `llm.listProviders` / `listModels` | `/dsh model` 自動完成 |
| `agents.get` / `create` / `resume` | `/dsh run` 的 `resolveAgent`（`lib/run.js`） |
| `agentPresets.mount` | `/dsh run` resume 冷 session 時重掛 preset |
| 事件 `session/created` | 新工作區出現 session → 自動建頻道 |
| 事件 `session/event` | `/dsh run` 的即時串流（`runTurn`） |
| 事件 `approval/request`（waterfall） | 授權卡片 Allow once / Deny（`lib/approval.js`） |
| 事件 `system-prompt/assemble`、`agent/request`（waterfall） | `installModelSelection` 把 model 選擇綁進 agent |

**結論**：plugin 目前是「會話歷史的唯讀投影 + 單一執行入口」——全部是 **pull** 模型，
而且完全沒有觸及搜尋、背景工作、token 用量、preset 選擇、workflow 觀察等 harness 已
提供的介面。以下是缺口。

---

## 二、讀取類缺口（API 現成，建議優先做）

### 1. 全文搜尋 —— `/dsh search <query> [session]` ★ 最大缺口
- **API**：`sessionQuery.searchSessions(request)`（跨 session 全文，回傳按最強命中排序的
  session hits）；`sessionQuery.searchEvents(request)`（單 session 內搜尋事件）。
- **現況**：bot 零搜尋能力。要知道 session id 才能查；手機上最常問的其實是「上次處理
  X 的是哪個 session」。
- **做法**：workspace 頻道內 → 用 metadata filters 限定該 workspace 的 corpus → 回傳
  top hits（session short id + 標題 + 命中摘要 + seq），使用者貼 short id 就能
  `/dsh trace`。`searchEvents` 可做成 `/dsh search <query> <session>` 精確定位事件。
- **成本**：中。渲染仿 `trace`，注意全文索引是 backend 提供（`searchSessions` 是
  abstract，web profile 的 backend 有實作）。

### 2. 背景工作 —— `/dsh jobs [id]`（list / read / kill）★ 次大缺口
- **API**：`jobs.list / get / read / kill / wait / onJobDone / onJobsChanged`。
- **現況**：web UI 有 jobs 面板（`dsh-client-ui-jobs`），Discord 端完全無感 —— 你在手機
  上不知道有沒有 job 在跑、跑完沒有、輸出在哪。
- **做法**：`/dsh jobs` 列（id、kind、狀態）；`/dsh jobs read <id>` 讀輸出；
  `/dsh jobs kill <id>` 中止。訂閱 `onJobDone` 推播「job 完成了」。
- **注意（owner 圍籬）**：jobs 以 owner session id 圍籬，host 層（plugin 所在的 unscoped
  context）無 caller 時**只能看到 unowned jobs**。要看到 agent 的 jobs，必須逐 agent 傳
  caller：`agents.list()` → `jobs.list(agent)`。這是實作上的重點，不是 bug。
- **安全**：`kill` 是寫入動作，建議歸在 `allowRun` 或獨立的 `allowJobs` 旗標下，不要
  跟唯讀指令同權。

### 3. Token 用量 —— `/dsh tokens [session]`
- **API**：`tokenMeter.measure(session, requestHeader)`、`estimateMessage(message)`。
- **現況**：web 端有 token meter；Discord 查不到「這個 session 燒了多少 token」。
- **成本**：低。`measure` 需要 live Session 物件（`sessions.get(id)`），冷 session 只能
  顯示「非 live」。

### 4. Skills 清單 —— `/dsh skills`
- **API**：`skills.list(options)`。
- **成本**：低。純資訊，適合「這個 harness 現在有哪些 skill 可用」。

### 5. Agent preset —— `/dsh preset [to]`（per workspace 偏好）
- **API**：`agentPresets.list()` / `resolve(id)`；`/dsh run` 的 resume 已經會 `mount()`。
- **現況**：README 自己講了「resume 只還原對話不還原 agent，preset 要重掛」——但
  operator 沒有辦法從 Discord 選「這個工作區要用哪個 preset」。
- **做法**：把 preset 選擇存成 per-workspace 偏好（可放頻道 topic 的既有
  `[dsh:<id>]` 機制延伸，或 plugin 自己的持久化），`resolveAgent` 時優先用它。
- **成本**：中。

### 6. Workflow 觀察 —— `/dsh workflow`
- **API**：`workflowEngine.start(request)`（也可以從 Discord **啟動** workflow）+ 事件
  `workflow/start`、`workflow/phase`、`workflow/log`、`workflow/end`、
  `workflow/agent-start`、`workflow/agent-end`。
- **現況**：bot 對 workflow 完全無感。
- **做法**：先做「status 顯示目前有幾個 workflow 在跑」；再訂閱 `workflow/end` 推播。
  進階：`/dsh workflow run <script>`（需 allowRun）。
- **成本**：中（觀察）到高（啟動）。

### 7. `/dsh status` 增強
- **API**：`agents.list()`（live agents）、`jobs`、`workflowEngine`、`skills`。
- **做法**：status 除了「session 總數 / live 數」外，加 live agents 數、job 數、
  workflow 數、可用的 skills/presets 數。
- **成本**：低，回饋大。

---

## 三、互動 / 執行面（都與 `allowRun` 綁，需安全設計）

### 8. `/dsh run` 卡片加 Stop 按鈕 ★ 執行面最重要的缺口
- **現況**：run 一送出就只能等 `whenIdle()`。遠端執行沒有中止鈕 = 把機器借出去就
  收不回來。
- **做法**：卡片加「🛑 Stop」按鈕。**具體 API 已有先例**：`dsh-chatgpt-bridge` 用
  `agent.cancel({ kind: 'user' })` 取消（DSH 原生 turn-end reason `aborted`），
  不是 PID 殺進程、也不是 `AgentHandle.dispose`（那是整隻 agent 的生命週期）。
- **成本**：中。安全上這是「緊急停止」，建議即使 `allowRun` 關閉也可用於自己發起的
  run。

### 9. 聊天模式收圖 / 附件（視覺輸入）
- **API**：`attachments.imageLimits` / `validateImage` / `saveImage` / `readImage`。
- **現況**：`listenToMessages` 只吃文字。Discord 訊息帶圖 → 完全被忽略。
- **做法**：下載 Discord 附件 bytes → `validateImage`（遵守 `imageLimits` 政策）→
  `saveImage` 拿 ref → 把 image ref 組進 user message content → 支援視覺的模型就看得到
  圖。跟 `/dsh run` 的 prompt 一起用。
- **成本**：中。

### 10. 長 prompt —— modal 取代 string option
- **現況**：`/dsh run` 的 prompt option 上限 1800 字；Discord modal text input 可到 4000。
- **成本**：低，UX 小提升。

### 11. permission preset —— `/dsh permission [to]`（per-session）
- **API**：`permissionPresets.current(events)` / `resolve(name)` / `set(session, name)`。
- **注意**：`set` 需要 **live** Session 物件；只能切「目前 live」的 session。而且切到
  `danger-full-access` 等於遠端提升執行權限 —— 非常敏感。建議第一版只做「顯示
  current」，切換要二次確認（重打指令或再按一次按鈕）。
- **成本**：中；安全敏感，可排後。

---

## 四、Push 通知（目前 100% pull；web UI 是 push）

### 12. Agent 生命週期推播
- **事件**：`agent/status`（idle ⇄ running）、`subagent/end`、`workflow/end`、
  `goal/changed`、`jobs.onJobDone`。
- **做法**：訂閱後把一行更新 post 到對應 workspace 頻道（例如「✅ turn 完成 in
  #my-api · 3 tool calls」）。需要 session → channel 的對應（現有 mapping 是
  workspaceId → channel，session/event 已帶 session，可反查）。
- **設計要點**：一定要 config 開關（例如 `notify: off | lifecycle | all`）+ 合併
  （debounce）+ 尊重 Discord rate limit（README 已講 5 msg / 5s）。這是從「你去問它」
  變成「它告訴你」的產品級差異。

### 13. `/dsh watch <session>` —— 跟蹤任意 session
- **做法**：把 `runTurn` 的 `session/event` 監聽推廣成「跟蹤任意 session」的命令：
  即時更新卡片 + Stop 鈕。現在只能看你**自己發起**的 run；web 端發起的 session 在
  Discord 看不到即時進度。
- **成本**：中。

---

## 五、需要 harness 先開 seam（plugin 自己做不到，列為上游 TODO）

1. **`ask_user_question` 橋接**：`userQuestions` 是「每 context 單一 provider」，web UI
   已佔用；plugin 再註冊 provider 會衝突。要把問題卡送到 Discord（像 approval 卡
   那樣）需要 harness 提供 waterfall 事件（如 `approval/request`）或允許多 provider。
   —— 這是 dsh 側的功能缺口，不是 plugin 側。
2. **跨 owner 的 jobs 唯讀列舉**：host 層看不到 agent 的 jobs（見第 2 點），要嘛逐
   agent 傳 caller，要嘛 harness 提供 host 層唯讀列舉。
3. **冷 session 改名**：`sessionTitle.rename(session, title)` 需要 **live** Session 物件，
   冷 session 無法直接改；`/dsh rename` 只能做 live。要支援冷 rename 需 harness 提供
   sessionQuery 層的 rename。

---

## 六、刻意不做（維持現狀）

| 能力 | 理由 |
|---|---|
| `credentials` / secrets 相關 | 絕不把金鑰帶進聊天平台。 |
| `sessionPersistence.readRaw` / `readSession` 原始 log 整包倒出 | `trace`/`timeline` 已夠；原始 log 交給 harness 自己。 |
| `settings` 全域改寫 | 危險，留給 web UI。 |
| `workspaceRegistry.delete`、刪 session | 破壞性操作，留在 dsh 本機。 |
| `/dsh compact`（`compaction.compactNow`） | 可行但風險 > 價值；真要就做二次確認。 |

---

## 七、生態 / 產品面（「整合到 dsh 上」的另一層意思）

- **進社群目錄**：`0xsline/awesome-deepseek-harness`、
  `awesome-dsh-plugin/awesome-dsh-plugin`、`Alex-Yanggg/awesome-DSH-plugin`、
  `AdamPlatin123/awesome-dsh-plugins` 四個目錄都在收 dsh-plugin（npm topic
  `dsh-plugin`），目前 dsh-discord-bot 未上榜（實查 4 個目錄都搜不到）。加 GitHub
  topic `dsh-plugin`、README badge，再送 PR 上目錄。
- **對照同類 bridge**：npm 上已有 `dsh-chatgpt-bridge`（MCP→ChatGPT）與
  `dsh-telegram-channel`、`dsh-im-hub`（IM 閘道），它們的文件結構見第八節。
- **bundle 化（選擇性）**：dsh 官方 plugin 是 profile bundle（`dsh.bundle.patch` +
  `dsh.profile.bundles`），讓 `dsh plugin` 與 HMR 管理一致；目前 setup 直接寫 user
  patch 層也完全合法（README 已解釋），bundle 化是讓「更新套件要重啟 dsh」這件事
  更順的選項。
- **i18n 一致性**：官方套件用 `README.i18n.yaml` 記錄中英 blob hash 對照；dsh-discord-bot
  目前是兩份手動同步，可仿照加一致性檢查（例如 CI 或 npm script）。
- **版本相容性**：README 已標 dsh `0.1.0-rc.6+`。建議補「實際測試過的 harness 版本」
  與 Node 版本矩陣（目前只寫 >=20）。

---

## 八、其他插件的文件 / 安裝說明慣例（對照結果）

實抓了 8 份 README（4 個 awesome 目錄、4 個社區插件全文、第一方 `dsh-mcp-client`
與 harness `AGENTS.md`），證據摘要如下。

### 生態主流安裝路徑：`dsh plugin add`，不是裸 `pnpm add` + patch insert
- 4 個 awesome 目錄都寫 `dsh plugin --profile <p> add <pkg|github:owner/repo#ref>`；
  **只有宣告 `dsh.bundle.patch` 的套件才會變成 profile 的 active bundle layer**
  （[0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)）。
- 對照插件（[dsh-im-hub](https://github.com/ThreeBody6666/dsh-im-hub)、
  [dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)、
  [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge)）全部是
  bundle 化 + `dsh plugin add`。
- dsh-discord-bot 目前是 setup script 直接寫 `cordis.patch.yml`（user patch 層）。
  合法，但**不在 `dsh plugin` 的管理範圍內**；宣告 `dsh.bundle.patch` 後即可
  `dsh plugin add dsh-discord-bot`，也解決 README 自己寫的「更新要重啟」痛點的一部分。

### 文件結構對照（哪些是別人有、dsh-discord-bot 缺/弱的）

| 章節慣例 | 誰在做 | dsh-discord-bot 現況 |
|---|---|---|
| `Services consumed` 表（`Service \| Usage`） | 第一方 `dsh-mcp-client` | ❌ 無（只有散落的 code comment） |
| 配置表含 Required / Default / 環境變數欄 | mcp-client（`Field\|Transport\|Required\|Description`）；telegram-channel（`key / env var \| meaning`） | ⚠️ 有表格但無 Required / 環境變數欄 |
| 一鍵安裝腳本（`curl \| bash` / `irm \| iex`，免 clone） | telegram-channel | ⚠️ 有 `bin/setup.js` 但要先 clone + `npm install`；可加免 clone 一鍵安裝 |
| 結構化 Troubleshooting 表（症狀 / 原因 / 修法） | telegram-channel（9 列）、chatgpt-bridge（Common errors） | ❌ 無（「Behaviour worth knowing」是散文） |
| `Known Limitations / Current limitations` 命名章節 | mcp-client、chatgpt-bridge | ⚠️ 有「Behaviour worth knowing」，無明示 limitations |
| Model Experience（模型看到什麼 / token 成本） | 第一方 mcp-client、web-app | ❌ 無（社區少見，可選） |
| DSH 版本相容行（目標版本 + Node + 最後驗證日期） | chatgpt-bridge（`0.1.0-rc.6`、Node ≥22、"zero DSH core modifications"） | ⚠️ 有 Requirements，無驗證日期 |
| 安裝 / 停用 / 解除安裝三件套 | chatgpt-bridge（Uninstall/disable）、telegram-channel | ⚠️ 有安裝，無停用/解除安裝說明 |
| 截圖（hero / 手機 / 桌面） | telegram-channel | ❌ 無（手機-first 產品卻無任何截圖） |
| 安全警告（「unauthenticated = RCE」式） | harness-mcp-server（⚠️ 明確警告）、im-hub（Security notes） | ⚠️ 有 Security 章節但沒有這種「最糟情境一句話」 |
| npm / license badge | harness-mcp-server | ❌ 無 |
| 雙語一致性記錄（`README.i18n.yaml` + verify script） | 第一方全體 | ⚠️ 兩份手動同步，無一致性檢查 |
| 可發現性（GitHub topic `dsh-plugin` + 上 awesome list） | telegram-channel 有「发布与发现」章節 | ❌ 4 個目錄都搜不到 oliver0804/dsh-discord-bot |

### 跨插件的安全/機密最佳實踐（可吸收進 Security 章節）
- **Token 機密**：環境變數優先（`DSH_TELEGRAM_TOKEN` 模式）；chatgpt-bridge 走
  config → env → 自動生成 token 檔（`$DSH_HOME/chatgpt-bridge.token`，與本 plugin 的
  `discord-bot.token` 同款）；截圖一律用佔位符（im-hub）；log 遮罩 secrets
  （chatgpt-bridge）——本 plugin 的 log 目前直接打 stderr，未遮罩。
- **權限範圍**：每 adapter 強制白名單、空=任何人（im-hub 的 `allowedUserIds` 與本
  plugin 同款）；workspace 邊界 + approval 逐次 allowed-once + 預設綁 loopback
  （chatgpt-bridge）；「未認證=可 RCE」式一句話警告（harness-mcp-server）。

### AdamPlatin123 的「合格插件 README 至少包含」檢查表（zh）
Overview / **Compatibility（支援的 DSH 版本或 mainline commit + 最後驗證日期）** /
Install-Uninstall / Quick start / **Configuration（defaults、env vars、敏感項目）** /
**Permissions & data（檔案、網路、credentials）** / **Troubleshooting（錯誤、log 位置、
rollback）** / Development / License & security（如何私下回報問題）。dsh-discord-bot 可以
拿這張表逐項打勾。

### 可直接抄的具體建議（4 條）
1. **補 `dsh plugin add` 安裝路徑**（仿 im-hub）：宣告 `dsh.bundle.patch`，README 的
   Install 節同時給 setup script 與 `dsh plugin add` 兩種方式。
2. **加 `Services consumed` 表**（仿 mcp-client）：把本文第一節的表格放進 README。
3. **加 Troubleshooting 表 + Known Limitations**（仿 telegram-channel / mcp-client）：
   token 錯、intent 被拒、Missing Access、50 頻道上限、同一 token 雙 harness……README
   裡散落的行為說明收進一張表。
4. **補雙語一致性與版本相容行**（仿 README.i18n.yaml / chatgpt-bridge）：加
   `README.i18n.yaml` 或至少 CI 檢查；README 標「最後驗證的 dsh 版本 + 日期」。

> 附註：chatgpt-bridge 是比 dsh-discord-bot 功能更廣的同類（連 `userQuestions` provider、
> goal supervision、`agent.cancel` 都做了），它的「單一 provider slot」限制說明正好佐證
> 本文第五節第 1 點：**web UI 佔住 `userQuestions` provider 時，問題只能流回 UI**。

---

## 建議的落地順序

1. **P0（低風險高價值，純讀）**：`/dsh status` 增強 → `/dsh search` → `/dsh jobs`（read-only）
2. **P1（執行面，需 allowRun 設計）**：run 卡 Stop 按鈕 → chat mode 收圖
3. **P2（push）**：agent 生命週期推播（config-gated）→ `/dsh watch`
4. **P3（上游）**：把第五節的 harness seam 需求回報 dsh 上游
5. **P4（生態）**：上 awesome 目錄、README 補 badge / i18n 一致性 / 版本矩陣
