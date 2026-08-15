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

## 為什麼能穿透外網

Bot 主動**向外**建立一條 WebSocket 連到 Discord gateway 並保持連線。所有指令都走這條既有連線
進來，所以即使機器位在 NAT、CGNAT、旅館網路或公司防火牆後面也照樣回應 —— **不用開通訊埠、不用
DDNS、不用反向代理，也不用把機器的鑰匙交給任何穿透服務**。只要筆電連得上 `discord.com`，你就能
從手機查詢它。

沒有任何東西在監聽，等於沒有新增對外攻擊面。

## 能做什麼、不能做什麼

**讀取** —— 工作階段、軌跡、原始事件時間軸、子代理、血緣關係。

**寫入** —— 註冊工作區（`/dsh workspace`）、切換預設模型（`/dsh model`）。

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

**3 — 安裝到 dsh profile。** 安裝腳本會裝套件、把 token 寫到
`$DSH_HOME/discord-bot.token`（權限 600），並在 profile 的 patch 層附加一列設定。沒帶的參數會
互動詢問；若已存在設定列，會在完全不動 profile 的情況下直接拒絕：

```bash
git clone https://github.com/Oliver0804/dsh-discord-bot
cd dsh-discord-bot
npm install
node bin/setup.js --profile web
```

安裝腳本會把 checkout 打包成 tarball 裝進 profile、寫入 token、附加設定列 ——
為什麼是裝 tarball 而不是 link 目錄，見*開發與建置*一節。

非互動模式：

```bash
node bin/setup.js --profile web --guild 123456789012345678 --token "$TOKEN" --yes
```

加上 `--print` 可以只預覽要寫入的設定列，不做任何變更。

接著重啟 dsh：

```bash
dsh --profile web
```

打開新出現的 **dsh** 類別，執行 `/dsh status`。

### 手動安裝

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm add dsh-discord-bot
```

在該 profile 的 `cordis.patch.yml` 附加：

```yaml
- insert:
    - id: discord-bot
      name: 'dsh-discord-bot'
      config:
        guildId: '123456789012345678'
        tokenFile: '/Users/you/.dsh/discord-bot.token'
        categoryName: 'dsh'
```

這個 plugin 屬於 **host** 層而非 agent preset：它服務所有工作區與所有工作階段，放進 preset
會變成每個 session 一份（而且第二個 session 就會撞名）。

## 指令

在工作區頻道內執行。`session` 參數有自動完成 —— 從最近的工作階段清單挑選，不必手打 uuid ——
省略時預設為該工作區最新的工作階段。

| 指令 | 回答什麼 |
|---|---|
| `/dsh help` | 你可以在這裡做什麼，以及怎麼開始。 |
| `/dsh sessions [limit]` | 這個工作區的工作階段：標題、是否運行中、時間。 |
| `/dsh trace [session] [limit] [everything]` | 軌跡 —— 問了什麼、回答什麼、跑了哪些工具。 |
| `/dsh timeline [session] [limit]` | 原始事件時間軸與型別統計。 |
| `/dsh subagents [session] [deep]` | 子代理清單，以及每個是**運行中**還是已結束。 |
| `/dsh run <prompt>` | 把工作送給該工作區的代理並即時觀看。需要 `allowRun`。 |
| `/dsh lineage [session]` | 上游與下游的工作階段關係。 |
| `/dsh model [to]` | 顯示或切換預設模型（選項由 provider 目錄自動完成；目錄為空時退回目前模型）。 |
| `/dsh workspace <path>` | 把一個目錄註冊成工作區並建立頻道（路徑有自動完成）。 |
| `/dsh status` | 已掛載的服務、工作階段數量、工作區清單與已對應的頻道數。 |
| `/dsh sync` | 立即重新同步類別、頻道與其私密設定。 |

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

Turn 的回報方式是**每隔幾秒改寫同一則訊息**：Discord 大約限制每個頻道 5 則訊息 / 5 秒，
而一個忙碌的 turn 會產生數百個事件。即時視圖會濾掉推理區塊，完整紀錄之後用 `/dsh trace` 看。

`runVerbosity` 決定那則訊息的內容。預設 `minimal`：執行中只顯示一行「正在跑哪個工具」，
結束時給出代理的最終回答與工具呼叫次數 —— **只給答案，不給過程**。`full` 則保留完整即時
逐條紀錄，適合你想看它「怎麼做」而不是「做出什麼」的時候。

Resume 一個冷的工作階段只會還原對話，**不會還原代理本身**：模型選擇與提供工具的 preset
都必須重新掛上，本套件兩件都會做。少掛 preset 會產生最難debug的失敗 —— 模型沒有工具
schema，於是把工具呼叫當成純文字寫出來，而沒有任何東西會去執行它。

當 harness 在這種 turn 中要求授權時，bot 會發一張含 **Allow once** / **Deny** 按鈕的卡片，
並遵守三條規則：

- **只回答從 Discord 發起的 turn**。你在 web UI 操作的工作階段仍然由 web UI 回答。
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

### 語言

回覆支援英文、繁體中文、簡體中文。`language: auto`（預設）會**跟隨執行指令那個人的 locale**，
這是共享頻道訊息最接近「因人而異」的做法；也可以指定一種語言，對所有人固定。

指令名稱與描述由 **Discord 自己在地化**，所以不論這個設定為何，每個人看到的指令選單都是他自己的
client 語言 —— 那個介面是讀者私有的，而回覆是頻道裡所有人都看得到的同一則訊息。

`/dsh trace` 與 `/dsh timeline` 的 footer 會帶上該工作階段的**全紀錄統計** —— 輪數、步數、
LLM 與工具耗時、首字時間、解碼速率、快取命中、token 數。這些是 dsh 自己摺算的數字，
跟 web 聊天介面那條統計列同源，所以翻頁與壓縮都不會改變它們。

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
npm test          # 42 個單元測試 —— 不需網路、不需 harness、不需 Discord 帳號
```

檔案分工：

| 檔案 | 職責 |
|---|---|
| `lib/index.js` | Cordis plugin 進入點：生命週期、連線、重試、日誌 |
| `lib/config.js` | 設定驗證與 token 解析 |
| `lib/workspaces.js` | 工作區視圖 —— registry，或退回 cwd 分組 |
| `lib/queries.js` | 所有 harness 讀取與兩個寫入 |
| `lib/render.js` | Discord embed、長度限制、附件溢出 |
| `lib/topology.js` | 類別／頻道同步與私密設定 |
| `lib/commands.js` | Slash 指令定義 |
| `lib/router.js` | 互動路由、授權、自動完成 |
| `bin/setup.js` | 安裝器 |

要在不動到自己 profile 的情況下測試真實 harness：安裝打包後的 tarball，
再用 overlay patch 在另一個 port 起第二個實例：

```bash
npm pack
(cd "${DSH_HOME:-$HOME/.dsh}/profiles/web" && pnpm add /path/to/dsh-discord-bot-0.1.0.tgz)
dsh --profile web --patch ./my-test-patch.yml --port 3099
```

請安裝打包後的 tarball，不要 link 原始碼目錄：被 link 的套件會解析到自己的 `node_modules`，
使 plugin 綁到**第二份** harness 套件 —— 與 host 持有的不是同一個 class 身分，症狀是 plugin
安靜地永遠不註冊。本套件不從 `@deepseek-ai/*` import 任何東西也是同一個原因，它與 harness 的
唯一接觸點就是傳進 `apply` 的 `ctx` 物件。

## 授權

MIT —— 見 [LICENSE](LICENSE)。
