# dsh-discord-bot

![dsh-discord-bot](docs/banner.png)

[English](README.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 投影到一個 Discord 伺服器：
一個類別底下**每個工作區一個文字頻道**，在頻道內用 `/dsh …` 指令查詢工作階段軌跡與當前子代理。

```
🗂 dsh                     ← 類別
   # dsh                   ← 工作區 /Users/you/Documents/dsh
   # sweepbot-home         ← 工作區 /Users/you/code/game/godot/sweepbot_home
   # my-api                ← 工作區 /Users/you/work/my-api
```

| 註冊一個工作區 | 頻道就長出來，而且是私密的 |
|---|---|
| ![註冊工作區，路徑對著 harness 機器的檔案系統自動完成](docs/screenshots/04-workspace-autocomplete-path.jpg) | ![新頻道出現在 dsh 類別底下，主題列帶著工作區 id](docs/screenshots/06-new-channel-in-sidebar.jpg) |
| **把工作送進去，即時看著跑** | **回頭讀它到底做了什麼** |
| ![執行中的卡片標出正在跑的工具，下面是軌跡、時間軸、子代理、待辦、匯出，以及插話與中斷](docs/screenshots/08-run-running.jpg) | ![軌跡：每一次工具呼叫與結果，頁尾是耗時、token 數與快取命中率](docs/screenshots/10-trace-ephemeral.jpg) |

Bot 用點擊者的語言回話，所以這幾張是某個伺服器的繁體中文介面 —— 見[*語言*](#語言)。
[更多截圖](docs/screenshots/)。

## 為什麼能穿透外網

Bot 主動**向外**建立一條 WebSocket 連到 Discord gateway 並保持連線。所有指令都走這條既有連線
進來，所以即使機器位在 NAT、CGNAT、旅館網路或公司防火牆後面也照樣回應 —— **不用開通訊埠、不用
DDNS、不用反向代理，也不用把機器的鑰匙交給任何穿透服務**。只要筆電連得上 `discord.com`，你就能
從手機查詢它。

沒有任何東西在監聽，等於沒有新增對外攻擊面。

## 能做什麼、不能做什麼

**讀取** —— 工作階段、軌跡、原始事件時間軸、子代理、血緣關係。

**自動推播** —— 開啟 `mirror: true` 之後，harness 上**任何地方**發起的 turn（web UI、tui、
排程）都會即時出現在它所屬工作區的頻道裡。**預設關閉**，因為它等於把工作階段內容持續匯出到
一個聊天平台。

**寫入** —— 註冊工作區（`/dsh workspace`）、切換預設模型（`/dsh model`）、
Agent 預設（`/dsh preset`）、權限模式（`/dsh permission`）。

**執行工作** —— `/dsh run <prompt>` 把 prompt 送給該工作區的代理，並即時回傳整個 turn。
**預設關閉**（`allowRun: false`），因為這是唯一一個「在你機器上產生實際動作」而非描述現況的指令。

> **開啟 `allowRun` 之前請先讀這段。** 一旦開啟，`allowedUserIds` 名單上的每個人都能從手機
> 讓代理在 harness 機器上改檔案、跑指令。這份名單就不再只是隱私邊界，而是 **shell 存取名單**。
> Bot 不會削弱 dsh 自己的 sandbox 與 approval 政策 —— harness 在本機會拒絕的事一樣會拒絕 ——
> 但在那個界線內，代理是真的會動手。名單請只留自己，而且若要啟用，permission preset
> 建議用 `ask` 而不是 `danger-full-access`。

**永遠不會** —— 無法繞過 dsh 的 sandbox、無法代替你批准、也無法碰到別的工作區頻道的工作階段。

## 頻道是私密的

類別與其頻道會拒絕 `@everyone`，只授權 bot 本身與 `allowedUserIds` 名單上的人 ——
名單留空時就只有伺服器擁有者。指令授權用的是同一份名單，所以「誰看得到」與「誰問得到」
永遠一致。

私密設定會在**每一次**同步時重新套用，而不只在建立時：已經存在的類別、或在啟用此設定之前
建立的頻道，都會被收斂成私密而不是放著不管。如果 bot 沒有*管理頻道*權限就無法限制任何東西，
這時它會在日誌與 `/dsh sync` 明確告警，而不是讓你以為已經鎖好了。

## 安裝

**1 — 建立 bot。** 到 [Discord Developer Portal](https://discord.com/developers/applications)：
*New Application* → *Bot* → *Reset Token* 複製 token。不需要任何特權 intent，Message Content
請保持**關閉**。

**2 — 邀請進伺服器**，勾選 `bot` 與 `applications.commands` scope：

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=268487696&scope=bot+applications.commands
```

這個數字是*查看頻道*、*傳送訊息*、*嵌入連結*、*附加檔案*、*管理頻道*、*管理身分組*。
最後一個是容易漏掉的：寫入頻道權限覆寫（也就是讓頻道變私密的動作）需要**管理身分組**，
而 Discord 只會用一句空泛的「Missing Access」回報缺少它。沒有這個權限 bot 仍然能運作，
但頻道會維持全伺服器可讀，而且每次同步都會告警。

**3 — 安裝到 dsh profile。** 一行指令。安裝腳本會裝套件、把 bundle 註冊進 profile、把 token 寫到
`$DSH_HOME/discord-bot.token`（權限 600），並在 profile 的 patch 層附加一列設定覆寫。沒帶的參數會
互動詢問；若已存在設定列，會在完全不動 profile 的情況下直接拒絕：

```bash
npx dsh-discord-bot-setup --profile web
```

非互動模式：

```bash
npx dsh-discord-bot-setup --profile web --guild 123456789012345678 --token "$TOKEN" --yes
```

加上 `--print` 可以只預覽要寫入的設定列，不做任何變更。

從 git checkout 執行（`node bin/setup.js …`）行為相同，差別只在它安裝的是*那份 checkout* 而不是
已發布的版本 —— 為什麼是打包成 tarball 而不是 link 目錄，見*開發與建置*一節。

接著重啟 dsh：

```bash
dsh --profile web
```

打開新出現的 **dsh** 類別，執行 `/dsh status`。

### 手動安裝

```bash
dsh plugin --profile web add dsh-discord-bot
```

這會裝好套件，並把它加進 profile 的 `dsh.profile.bundles` —— 這一步才讓本套件自帶的
`cordis.patch.yml` 成為組合樹的一層，而那一層負責掛載 plugin。掛上之後它會以**離線**狀態啟動並在
日誌說明原因，因為還沒有人告訴它要綁哪個 guild。在該 profile 自己的 `cordis.patch.yml` 用
id 指定覆寫補上：

```yaml
- id: discord-bot
  config:
    guildId: '123456789012345678'
    tokenFile: '/Users/you/.dsh/discord-bot.token'
    categoryName: 'dsh'
```

是**覆寫**，不是再寫一個 `insert`。bundle 層已經掛了那一列，而兩層帶同一個 id 並不會合併 ——
它們會組合出兩個實例，也就是兩個 bot 連同一個 guild、每道指令回答兩次。
`dsh --profile web --dump-config` 可以看組合後的樹：那一列應該只出現一次，標頭是
`dsh-discord-bot, patched by <你的 cordis.patch.yml>`。

這個 plugin 屬於 **host** 層而非 agent preset：它服務所有工作區與所有工作階段，放進 preset
會變成每個 session 一份（而且第二個 session 就會撞名）。

### 從 0.3.1 以前的版本升級

那些版本沒有 bundle 層，所以安裝腳本寫進 profile 的是一列完整的 `insert:`。現在套件會自己掛載，
那一列就變成**第二個** bot。把它換成上面的覆寫形式，值保留原本的：

```yaml
# 之前                             # 之後
- insert:                         - id: discord-bot
    - id: discord-bot               config:
      name: 'dsh-discord-bot'         guildId: '…'
      config:                         tokenFile: '…'
        guildId: '…'
```

還沒改之前也不會壞：bundle 那一列沒有任何設定，所以它只會在日誌留下一行「缺 `guildId`」然後停在
離線狀態，而不是讓整個組合失敗。改完用 `dsh --profile web --dump-config` 確認 —— 只有一個
`id: discord-bot`，不是兩個。

## 指令

在工作區頻道內執行。`session` 參數有自動完成 —— 從最近的工作階段清單挑選，不必手打 uuid ——
省略時預設為該工作區最新的工作階段。

![在頻道裡打 /dsh 就叫出完整的指令表，每一個都附說明](docs/screenshots/01-command-palette.jpg)

| 指令 | 回答什麼 |
|---|---|
| `/dsh help` | 你可以在這裡做什麼，以及怎麼開始。 |
| `/dsh menu` | 開一張卡片，用下拉選單完成以下所有操作，不必再打字。 |
| `/dsh sessions [limit]` | 這個工作區的工作階段：標題、是否運行中、時間。 |
| `/dsh search <query> [limit]` | 以全文搜尋這個工作區的工作階段，按 harness 自己的索引排序。 |
| `/dsh trace [session] [limit] [everything]` | 軌跡 —— 問了什麼、回答什麼、跑了哪些工具。 |
| `/dsh timeline [session] [limit]` | 原始事件時間軸與型別統計。 |
| `/dsh subagents [session] [deep]` | 子代理清單，以及每個是**運行中**還是已結束。 |
| `/dsh run <prompt>` | 把工作送給該工作區的代理並即時觀看。需要 `allowRun`。 |
| `/dsh lineage [session]` | 上游與下游的工作階段關係。 |
| `/dsh model [to]` | 顯示或切換預設模型（選項由 provider 目錄自動完成；目錄為空時退回目前模型）。 |
| `/dsh todos [session]` | 執行中工作階段正在跑的待辦清單。 |
| `/dsh context [session]` | 那個工作階段實際擁有的提示區段、工具與技能。 |
| `/dsh export [session]` | 完整軌跡，輸出成 Markdown 附件。 |
| `/dsh cmd [name] [input]` | 列出或執行 **harness 自己的指令** —— `/compact`、`/plan`，以及這個部署註冊的任何指令。執行需要 `allowRun`。 |
| `/dsh stop [session]` | 中斷某個工作階段現在正在跑的 turn。需要 `allowRun`。 |
| `/dsh rewind [session]` | 從較早的提示接續，開成新的工作階段。需要 `allowRun`。 |
| `/dsh preset [to]` | 顯示或切換新工作階段使用的 Agent 預設。切換需要 `allowRun`。 |
| `/dsh permission [to] [session]` | 顯示或切換權限：新工作階段的預設值，或某個執行中的工作階段。切換需要 `allowRun`。 |
| `/dsh workspace <path>` | 把一個目錄註冊成工作區並建立頻道（路徑有自動完成）。 |
| `/dsh status` | 已掛載的服務、工作階段數量、工作區清單與已對應的頻道數。 |
| `/dsh sync` | 立即重新同步類別、頻道與其私密設定 —— 順便把「位在某個已註冊工作區目錄下、卻沒被掛進去」的工作階段補歸檔。 |

`trace` 直接使用 harness 自己的語意文件投影，所以推理區塊、串流分塊、結構性邊界都已經濾掉了；
`everything: true` 則保留其餘內容。任何超過單則訊息長度的結果會轉成 `.txt` 附件，不會被靜默截斷。

`model` 改的是部署層級的預設值，只影響**之後新建**的工作階段；已在運行的工作階段仍維持它建立時
的模型。dsh 的 `saveSelection` 在 profile 沒有 settings provider 時是靜默 no-op，因此寫入後會
讀回比對，沒有真的生效就回報失敗，而不是假裝成功。

`workspace` 接受**harness 這台機器上**已存在目錄的絕對路徑，成功後立即同步，新頻道會同時出現。
`path` 會**對真實檔案系統做自動完成**：打一段路徑就往下走，打一個純名稱則會比對「harness
已知工作區的兄弟目錄」。在手機上手打完整路徑並不合理，而 harness 不會解析任何相對於 Discord 的路徑。

自動完成同樣只回答允許名單上的人：工作階段標題與目錄名稱都是關於這台機器的真實資訊，
因此提示與指令受同一道關卡保護。

### 執行工作與授權卡片

`run` 接續該工作區最新的工作階段——除非還有更舊的工作階段仍在運行，因為**同一工作區
絕不會同時跑兩個代理**。已在運行的代理直接用，冷的則 resume 回來（會一併重掛模型選擇與
preset，見下），而**還沒有任何工作階段的工作區會直接建一個新的**，根目錄就是該工作區。
每次 run 也會把 session 登記到 dsh 的 workspace 帳戶下，所以它會出現在該工作區的頻道，
而不是「Ungrouped」。

從其他地方開始的工作階段則由 `/dsh sync` 補歸檔：只要它的 cwd **精確等於**某個已註冊工作區的
目錄、而且還沒被掛上去，就會被歸進該工作區。「精確」是重點：`/a/b` 是 `/a/b/sub` 的父目錄，
比對放寬一點就會把子專案的工作階段歸到父專案底下。少了這一步，dsh 自己的側邊欄可能一邊把某個
工作區顯示成空的、一邊把它的工作階段列在「Ungrouped」—— 而這個 bot 讀取時有 cwd 後備規則、
看起來一切正常，於是兩邊對同一批資料的說法就對不上。

Turn 的回報方式是**每隔幾秒改寫同一則訊息**：Discord 大約限制每個頻道 5 則訊息 / 5 秒，
而一個忙碌的 turn 會產生數百個事件。即時視圖會濾掉推理區塊，完整紀錄之後用 `/dsh trace` 看。

執行中的卡片會帶按鈕：**軌跡**、**時間軸**、**子代理**、**待辦**與**匯出**會以私訊方式回覆
與 slash 指令相同的內容。`allowRun` 開啟時第二列會多出 **插話**（開 modal，在下一個步驟邊界
送入訊息）與 **中斷**（兩段式：第一次點擊先變成確認/取消，避免誤觸）。按鈕是無狀態的，
留在捲動紀錄裡的卡片重啟後仍然有效。

`runVerbosity` 決定那則訊息的內容。預設 `minimal`：執行中只顯示一行「正在跑哪個工具」，
結束時給出代理的最終回答與工具呼叫次數 —— **只給答案，不給過程**。`full` 則保留完整即時
逐條紀錄，適合你想看它「怎麼做」而不是「做出什麼」的時候。

Resume 一個冷的工作階段只會還原對話，**不會還原代理本身**：模型選擇與提供工具的 preset
都必須重新掛上，本套件兩件都會做。少掛 preset 會產生最難debug的失敗 —— 模型沒有工具
schema，於是把工具呼叫當成純文字寫出來，而沒有任何東西會去執行它。

當 harness 在這種 turn 中要求授權時，bot 會發一張含 **Allow once** / **Deny** 按鈕的卡片，
並遵守三條規則：

- **預設只回答從 Discord 發起的 turn**，你在 web UI 操作的工作階段仍然由 web UI 回答。
  `mirrorApprovals: true` 可以改成另一種姿態 —— 見*看見不是你發起的工作*。
- 按下按鈕的人會用 `allowedUserIds` 檢查 —— 看得到頻道不等於有權批准。
- 兩分鐘內沒人回答，就把問題交還給 dsh，而不是自己決定。**逾時不是同意，也不是拒絕。**

### 聊天模式

設定 `listenToMessages` 之後，在工作區頻道**直接打字就是下工作**，不必用 slash 指令：

| 值 | 行為 |
|---|---|
| `off`（預設） | 完全忽略訊息，只有 `/dsh run` 有作用。 |
| `mention` | 只有 @ 到 bot 的訊息會被當成 prompt。 |
| `all` | 工作區頻道內的每則訊息都是 prompt。以 `/` 開頭的訊息會被忽略——否則會跟指令表面衝突。 |

聊天模式同時需要 `allowRun`，並且需要 **Message Content** 特權 intent —— 你必須先到 Developer
Portal 的 *Bot → Privileged Gateway Intents* 開啟它。**應用程式請求一個沒有啟用的 intent 時，
Discord 會直接拒絕整條連線**，所以 bot 只在這個設定開啟時才索取；萬一仍被拒絕，它會停下來並
指出是哪一種修法，而不是無限重試。

被拒絕的訊息一律**靜默忽略**：這個 handler 會看到伺服器裡的每一則訊息，逐一回覆拒絕會把正常
對話變成一串拒絕訊息 —— 而且告訴未授權的人「你沒有權限」，等於告訴他這個 bot 值得試探。

### 觸及 harness 的其餘部分

上面有六個指令的存在，是因為 harness 不只是它的工作階段紀錄；而它能做的大部分事情，
這個套件其實不需要知道那是什麼就能接上。

**`/dsh cmd` 是那個逃生口。** `dsh-commands` 是 harness 與其 plugin 發布人類指令的地方，
所以「列出註冊表」拿到的就是這個部署**實際擁有**的東西 —— `/compact`、`/plan`、`/goal`，
以及之後才安裝的任何指令 —— 而不是一份會過期的硬編清單。執行走註冊表自己的 executor，
它會寫入成對的 `command/run` 與 `command/done` 紀錄，並**沿著 agent 的 scope 解析 handler**。
最後這點正是 `/dsh cmd compact` 能運作的原因：shipped preset 把 compaction 服務關在自己的
isolate realm 裡，從 host plane 用 `ctx.get(…)` 什麼都拿不到。現在這個 bot 所有「關於某個
工作階段」的讀取都照同一條路徑解析 —— 先問 agent，再問 host plane。

**它在跑的時候打字，是插話而不是排隊。** 如果 turn 已經在跑 —— 不論從這裡還是從機器上發起 ——
新的提示會在那個 turn 的**下一個 step 邊界**送達，而不是排成另一個完整的 turn。這才是
「打斷一段對話」的意思。回覆會說明並就此停住：那個 turn 屬於發起它的人，而鏡射已經在報告它了。
插話一樣是在造成工作，所以跟其他觸及代理的功能一樣需要 `allowRun` —— 聊天模式也不例外。

**`/dsh stop` 是斷路器。** 跑歪的 turn 可以從手機中斷，包含在機器上發起的。排隊中與插話的
輸入會一併丟棄 —— 中斷後還留著待送佇列，等於把剛剛停下來的工作又叫起來。

**`/dsh rewind` 會 fork，但不洩漏。** 從選單挑一個較早的提示，對話會以**新的工作階段**
繼續，停在那個提示之前；原本的完全不動。seed 是從 live log 自己切出來的，而不是用
`sessions.fork()` —— 那個呼叫會在 store 裡建立一個 live 子工作階段，而 `agents.create`
必須擁有自己驅動的工作階段，所以用它等於每次回溯都丟下一個沒人管的工作階段。

**丟進頻道的檔案會變成上下文。** 聊天模式下，訊息附帶的文字檔會被讀取並附加到同一則提示 ——
打字的內容仍然排在第一，那才是逐字稿會顯示的東西。只抓訊息自己的 Discord CDN 附件
（絕不抓訊息文字裡的 URL）、只讀文字型別、最多 5 個檔案、每個上限 100 KB。

### 看見不是你發起的工作

前面所有東西都是「你問才查」。`mirror: true` 補上另一個方向：plugin 訂閱 harness 自己的
append feed —— 未 scoped 的 listener 會收到**每一個** session 的事件，不只是這個 bot 建立的 ——
再把每個 turn 報進它所屬工作區的頻道。

形式和 `/dsh run` 完全一樣，而且是刻意的：**一個 turn 一則訊息，每隔幾秒改寫**，直到 turn 結束。
逐事件發訊息撐不過 Discord「每頻道 5 則 / 5 秒」的限制，而且一張可以盯著看的卡片，也勝過一整面
要往上捲的牆。卡片同樣帶讀取按鈕，`allowRun` 開啟時還有 **插話** 與兩段式 **中斷**，
所以在機器端開始的 turn，也能在手機上查看、插話或打斷。

- 工作階段的歸屬用的是跟指令一樣的聯集：工作區的 registry 帳戶，或 registry 還沒登記時的 cwd。
- **子代理預設不推**（除非 `mirrorSubagents: true`）。一個 turn 可以展開出十幾個子代理，
  而且它們共用父代理的目錄，全推會直接把頻道淹掉。
- 這個 bot 自己發起的 turn **不會**重複推播 —— `runTurn` 已經把它報進發起它的那則回覆。
- 工作區還沒有頻道時，該 turn 會被**留著**而不是丟掉，直到 `followNewWorkspaces` 把頻道同步出來
  （最多留兩分鐘）。
- **沒有離線補送。** Bot 離線期間追加的事件，從推播的角度就是遺失了；`/dsh trace` 仍然讀得到，
  因為它讀的是 log 而不是事件流。

`mirrorApprovals: true` 會把授權卡片擴大到**不是**這個 bot 發起的工作階段 —— 這正是「人在外面，
用手機就能解開機器上卡住的工作」所需要的。代價很實在，必須講清楚：卡片還在等的時候，
坐在 web UI 前面的人最多有兩分鐘看不到那個提示 —— answerer 是 waterfall，而問題已經被這個 bot
接走了。預設關閉就是因為這一點。

完整的雙向設定（代表你接受上面所有取捨）：

```yaml
config:
  mirror: true            # harness → Discord：每個 turn 即時推播
  mirrorApprovals: true   # 任何地方發起的工作階段，授權都送到 Discord
  allowRun: true          # Discord → harness：/dsh run
  listenToMessages: all   # Discord → harness：直接打字就是派工
```

### 回答模型提出的問題

`ask_user_question` 會把一個工具呼叫**停在那裡**，等人回答。跟授權不同的是，那個接縫
**只接受一個 provider**，註冊第二個會直接拋錯 —— 所以 `answerQuestions` 預設關閉，
而且這不只是包個 try/catch：在 web profile 裡，`dsh-host-apiproxy` 擁有那個接縫，
而坐在瀏覽器前面的人才是正在等那份問卷的人。

這個接縫是在 **bot 連上 Discord 之後**才接管的，絕不在啟動階段 —— 這個順序是必要的，不是講究：
patch 層的 plugin 列會**比它後面那些 bundle 更早**套用，所以在啟動階段接管會讓
`dsh-host-apiproxy` 自己的註冊失敗，**整個 harness 直接開不起來**。等到 gateway 起來才接管，
就把這個 bot 排到最後 —— 只要有任何 UI 擁有那個接縫，它早就拿走了，而這個 bot 會退讓。

過去退讓就結束了，而這正好把這個 bot 存在的理由晾在一邊：一個停下來問問題的 turn，
會一直停到有人坐到瀏覽器前面為止。所以搶輸接縫的 bot 改走另一條路進去。它是跟 gateway
跑在**同一個 cordis context** 裡的 plugin，所以 `ctx.apiProxy` —— 瀏覽器透過 HTTP 對話的
那個物件本身 —— 在這裡就是一個直接呼叫：不用開埠、不用憑證、不用第二套傳輸。
訂閱它的事件流就拿得到網頁 UI 正在顯示的那些待答問題，答案也走網頁 UI 用的同一個入口回去。

**兩邊同時有效。** gateway 會在結算一個待答問題之前先把它移除，所以誰先回答誰算數，
另一邊的卡片會自己收起來 —— 手機或瀏覽器，你先碰到哪個就用哪個。這個模式唯一不做的事
就是替人決定：它並不擁有這次詢問，所以沒人回答的卡片只會安靜失效，並說明問題還在網頁介面等著。
送出取消會直接結算掉一個可能有人正在看的問題。

開啟之後，每道問題會以一張帶選單的卡片送達，並受同一份允許名單保護。有選項可以直接選；
無論有沒有選項，都可以按 **✍️ 自行輸入** 開 modal 打自由文字，所以開放式問題也能回答。
沒人回答的卡片會在十五分鐘後**拒絕**這次詢問 —— 這裡沒有 `next()` 可以把問題交回去，
而一個永遠卡住的工具呼叫，比一個被取消的更糟。

### 卡片選單

`/dsh menu` 會發一張卡片，把整個指令表面變成不用打字的操作 —— 這在手機上很重要，而手機正是這個
bot 存在的理由。五排：要看什麼、選哪個工作階段、要改哪個設定、那個設定的選項、以及一排
**搜尋**（開 modal）、**同步**、重新整理／關閉。

![卡片選單：檢視、工作階段、要改哪個設定三個下拉，下面是搜尋、同步、重新整理與關閉](docs/screenshots/11-menu.jpg)

這張卡片**沒有任何伺服器端狀態**：目前的檢視、選中的工作階段、開著的設定選單，全部編碼在它自己
元件的 id 裡，下次點擊時再讀回來。所以昨天發的卡片在重啟之後照樣能用 —— **訊息本身就是狀態**。
讀取對允許名單上的所有人開放；Agent 預設與權限這兩個選單則在沒有 `allowRun` 時是停用狀態，
因為它們決定的是之後的 turn 被允許做什麼。

### 語言

回覆支援英文、繁體中文、簡體中文。`language: auto`（預設）會**跟隨執行指令那個人的 locale**，
這是共享頻道訊息最接近「因人而異」的做法；也可以指定一種語言，對所有人固定。

指令名稱與描述由 **Discord 自己在地化**，所以不論這個設定為何，每個人看到的指令選單都是他自己的
client 語言 —— 那個介面是讀者私有的，而回覆是頻道裡所有人都看得到的同一則訊息。

`/dsh trace` 與 `/dsh timeline` 的 footer 會帶上該工作階段的**全紀錄統計** —— 輪數、步數、
LLM 與工具耗時、首字時間、解碼速率、快取命中、token 數。這些是 dsh 自己摺算的數字，
跟 web 聊天介面那條統計列同源，所以翻頁與壓縮都不會改變它們。

跑在有公開價目的模型上時，footer 還會多一段**費用估算**，寫成區間（`估 ¥2.95–5.91`）。
區間不是含糊：DeepSeek 的空閒時段單價正好是高峰的一半，而 token 統計是累計值、裡面沒有時段
分桶，所以橫跨兩個時段的工作階段本來就無法收斂成一個數字 —— 下界是全程空閒、上界是全程高峰，
真實數字落在中間。模型認不出來就不顯示，不會拿舊版價目去猜。`/dsh status` 另有一格顯示
**當下屬於哪個時段、下一個分界在幾點**，那是問「現在開跑貴不貴」，跟 footer 的事後帳互補。

## 設定項

| 鍵 | 預設 | 意義 |
|---|---|---|
| `guildId` | *必填* | 此 bot 服務的唯一伺服器，其他來源的互動一律忽略。 |
| `token` | — | 直接寫 token，建議改用 `tokenFile`。 |
| `tokenFile` | — | 檔案的第一行非註解內容作為 token。 |
| `categoryName` | `dsh` | 放置工作區頻道的類別名稱。 |
| `allowedUserIds` | `[]` | 允許查詢的 Discord 使用者 id。**留空代表只有伺服器擁有者。** |
| `manageChannels` | `true` | 是否允許 bot 建立與更名類別和頻道。 |
| `privateChannels` | `true` | 拒絕 `@everyone`，只授權 bot 與 `allowedUserIds`。 |
| `allowRun` | `false` | 啟用 `/dsh run`。**等於把這台機器的代理執行權交給名單上的人。** |
| `listenToMessages` | `off` | `off` / `mention` / `all` —— 把頻道訊息當成 prompt。需要 `allowRun` 與 Message Content intent。 |
| `runVerbosity` | `minimal` | `minimal` 只給答案；`full` 串流完整過程。 |
| `language` | `auto` | `auto` / `en` / `zh-Hant` / `zh-Hans` —— 回覆使用的語言。 |
| `mirror` | `false` | 把 harness 跑的每個 turn 推進它所屬工作區的頻道，不論由誰發起。**等於持續匯出工作階段內容。** |
| `mirrorSubagents` | `false` | 推播是否包含子代理工作階段。一個 turn 可以展開出十幾個。 |
| `mirrorNewSessions` | `true` | 新工作階段建立時在頻道公告一則。只在 `mirror` 開啟時有作用。 |
| `mirrorApprovals` | `false` | 連不是這個 bot 發起的工作階段，授權問題也送到 Discord。**web 端的人得等這張卡片的兩分鐘。** |
| `answerQuestions` | `false` | 在 Discord 回答 `ask_user_question`。接縫沒人佔就接管；被 UI 佔走則改鏡射 gateway 的待答問題，**兩邊都能回答，誰先答誰算數**。 |
| `followNewWorkspaces` | `true` | 出現未對應工作區的新工作階段時自動建立頻道。 |
| `traceLimit` | `25` | `/dsh trace` 預設筆數 —— 也是 `/dsh timeline` 的預設筆數。 |
| `sessionLimit` | `15` | `/dsh sessions` 預設筆數。 |
| `retrySeconds` | `30` | Discord 登入失敗的重試間隔。 |

Token 也可以來自環境變數 `DSH_DISCORD_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN`。
優先順序為 `token` → `tokenFile` → 環境變數。

## 安全性

- **綁定單一伺服器**：其他伺服器的互動在授權檢查之前就被丟棄。
- **允許名單**：`allowedUserIds` 留空時只授權伺服器擁有者，不會開放給全體成員；要放寬請明確加入
  id。同一份名單也決定頻道可見性。
- **預設私密頻道**：`@everyone` 被拒絕，只有 bot 與名單上的人讀得到。
- **不要求特權 intent**：只用 `Guilds`，bot 讀不到任何人的訊息內容。
- **工作階段文字會先淨化**再進入訊息：程式碼區塊無法逸出，提及無法對伺服器發通知。
- **沒開就無法執行**：`allowRun` 預設關閉；關閉時沒有任何指令能跑命令或驅動代理。開啟後，
  允許名單就等於 shell 存取名單 —— 見文件開頭的警告。
- **授權永遠不會自動發生**：bot 無法代替你批准，逾時的卡片會交還給 dsh 而非自行決定。
- **自動推播是選擇加入的**：`mirror` 預設關閉時，沒有人問就沒有任何東西進到頻道。一旦開啟，
  每個工作階段的對話都會持續匯出到 Discord —— 包含別人在這台機器上開始、而他從未選擇這件事的工作。
- **`/dsh cmd`、`/dsh stop`、`/dsh rewind` 都需要 `allowRun`**：三者分別是「造成工作」、
  「終止別人可能正在看的工作」、「產生一個新代理」，沒有一個是讀取，`allowRun` 關閉時一律不可用。
- **附件只從 Discord CDN 讀取**，不會去抓訊息文字裡的 URL，只讀文字型別，最多 5 個檔案、
  每個 100 KB。
- **切換 preset 或 permission 需要 `allowRun`**：這兩者本身不執行任何東西，但它們決定之後的 turn
  被允許做什麼 —— 用哪些工具組成、指令是否進 sandbox 或需要批准 —— 所以放寬它們的關卡等同執行，
  而不是等同讀取。

### Token 放在哪裡

Token 應該住在 `$DSH_HOME/discord-bot.token`（安裝腳本以 600 權限寫入）——
**絕不放進這個 repo，也不要寫進會提交的 profile**。`.gitignore` 擋掉 `.env`、`*.token`、
`*.secret` 作為最後防線，但真正的保護是這個檔案根本不在專案樹裡，設定列只用路徑引用它。

Token 一旦被貼進 shell、聊天或 commit，就視為已洩漏：到 Developer Portal 重置，並重寫 token 檔。
外洩的 bot token 等於讓任何人讀得到這個 bot 看得到的所有頻道。

### 如果類別已經存在、而且已經是私密的

**全新安裝不需要任何手動權限設定**：類別是 bot 自己建的，建立當下就把自己的存取權寫進去，
所以類別是私密的、bot 看得到、底下每個頻道也都同時繼承這兩件事。

唯一會壞掉的情況是：類別**在 bot 進場之前就被手動設成私密**，而且沒有給 bot 例外。
這時 bot 就被關在它該管的門外 —— 無法限制頻道、無法在其下建新頻道、也收不到訊息（聊天模式失效）。
Slash 指令仍可用，因為 interaction 自己帶 token。

**邀請 URL 救不了這個**：`permissions=` 給的是伺服器層級權限，而**頻道層級的覆寫會蓋過伺服器層級權限**；
唯一能繞過覆寫的只有 `Administrator`，那對這個用途來說權限大得離譜。二選一：

- **手動授權一次** —— 類別 → *編輯類別* → *權限* → 加入 bot、允許*查看頻道*。
  現有頻道與歷史全部保留，之後 bot 就接管了。
- **讓 bot 重新來過** —— 把 `categoryName` 指向一個還不存在的名稱，下次同步就會建出一個正確的。
  舊頻道留在原地不動。

兩種做法之後，`/dsh sync` 都會回報 `🔒 private` 而**不帶**「set outside the bot」——
那就是「bot 真的在管理它」而不只是「看著它」的訊號。

## 值得知道的行為

- **任何失敗都不會拖垮 dsh。** Token 錯誤、權限被撤、沒有網路，都只會記錄警告並重試，harness
  照常啟動與運作。這點很重要：Cordis 會把啟動期的例外視為 composition 失敗 ——
  `dsh-host-webserver` 在通訊埠被佔用時確實會讓整個進程停掉，而一個聊天橋接不該有這種行為。
- **永不刪除頻道。** 工作區從 dsh 移除後，頻道與歷史訊息都會保留，`/dsh status` 會列出這些殘留。
- **對應關係存在頻道主題**（`[dsh:<workspaceId>] …`）而非記憶體，因此重啟與更名都不會失聯。
  清空主題即可解除對應。
- **Discord 限制單一類別最多 50 個頻道。** 超過的工作區會維持未對應狀態並記錄下來，而不是靜默略過。
- **沒有 `ctx.workspaceRegistry` 時**（tui 與 headless profile 不掛載它），會改用工作階段的
  `cwd` 分組，其餘功能完全相同。
- **更新套件必須重啟 dsh。** dsh 的 HMR 重載的是 *composition*，所以在執行中的 harness 加入
  設定列就能讓 bot 上線、不必重啟 —— 但 Node 已經快取了 module，之後 `pnpm add` 新版本要等
  進程重啟才會生效。一個一直開著的 harness 會永遠用它第一次載入的版本回應。
- **絕對不要用同一個 bot token 跑兩個 harness。** Discord 只會把每個 interaction 送給其中一個
  已連線的 session，所以兩個實例會隨機搶答：一半指令打到舊版，另一半以「Unknown interaction」
  失敗。第二個 harness 請用它自己的 bot application。

## 需求

- dsh `0.1.0-rc.6` 以上，且已組合 `sessionQuery`（所有基於 `dsh-base` 的 profile 都有）
- Node.js 20+

## 開發與建置

**沒有建置步驟。** 套件直接發佈它執行的 JavaScript：純 ESM，不用 TypeScript、不用打包器、
不做轉譯。`lib/` 同時是原始碼與發佈產物，你讀到的就是 dsh 裡實際執行的東西。

```bash
git clone https://github.com/Oliver0804/dsh-discord-bot
cd dsh-discord-bot
npm install       # 只有 discord.js
npm test          # 76 個單元測試 —— 不需網路、不需 harness、不需 Discord 帳號
```

檔案分工：

| 檔案 | 職責 |
|---|---|
| `lib/index.js` | Cordis plugin 進入點：生命週期、連線、重試、日誌 |
| `lib/config.js` | 設定驗證與 token 解析 |
| `lib/workspaces.js` | 工作區視圖 —— registry，或退回 cwd 分組 |
| `lib/queries.js` | 所有 harness 讀取與四個寫入 |
| `lib/render.js` | Discord embed、長度限制、附件溢出 |
| `lib/topology.js` | 類別／頻道同步與私密設定 |
| `lib/commands.js` | Slash 指令定義 |
| `lib/router.js` | 互動路由、授權、自動完成 |
| `lib/mirror.js` | 推播端：緩衝、一個 turn 一則訊息、呼叫額度 |
| `lib/activity.js` | 誰正在工作，來自 `agent/status` |
| `lib/scope.js` | 讀取關在 agent preset realm 裡的服務 |
| `lib/questions.js` | 問題卡片，以及本 bot 接管接縫時的 `ask_user_question` provider |
| `lib/questions-mirror.js` | 接縫被 UI 佔走時，改用 `ctx.apiProxy` 驅動同一張卡片 |
| `lib/attachments.js` | 頻道檔案，讀成提示的 content block |
| `lib/routing.js` | 工作階段 → 工作區 → 頻道的解析與快取，與授權卡片共用 |
| `lib/menu.js` | `/dsh menu` 卡片與它的無狀態元件 |
| `bin/setup.js` | 安裝器：套件、bundle 註冊、token、設定覆寫 |
| `cordis.patch.yml` | bundle 層 —— 只負責掛載 plugin，不帶任何設定 |

要在不動到自己 profile 的情況下測試真實 harness：安裝打包後的 tarball，
再用 overlay patch 在另一個 port 起第二個實例：

```bash
npm pack
(cd "${DSH_HOME:-$HOME/.dsh}/profiles/web" && pnpm add /path/to/dsh-discord-bot-<版本>.tgz)
dsh --profile web --patch ./my-test-patch.yml --port 3099
```

請安裝打包後的 tarball，不要 link 原始碼目錄：被 link 的套件會解析到自己的 `node_modules`，
使 plugin 綁到**第二份** harness 套件 —— 與 host 持有的不是同一個 class 身分，症狀是 plugin
安靜地永遠不註冊。本套件不從 `@deepseek-ai/*` import 任何東西也是同一個原因，它與 harness 的
唯一接觸點就是傳進 `apply` 的 `ctx` 物件。

## 授權

MIT —— 見 [LICENSE](LICENSE)。
