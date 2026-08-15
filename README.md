# dsh-discord-bot

English | [中文](README.zh.md)

Projects a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) onto one Discord
guild: a category holding **one text channel per workspace**, and `/dsh …` commands that read
session trajectories and live subagents from inside those channels.

```
🗂 dsh                     ← the category
   # dsh                   ← workspace /Users/you/Documents/dsh
   # sweepbot-home         ← workspace /Users/you/code/game/godot/sweepbot_home
   # my-api                ← workspace /Users/you/work/my-api
```

## Reaching a machine you cannot route to

The bot opens a **WebSocket out** to Discord's gateway and keeps it open. Every command arrives
over that existing connection, so the harness answers from behind NAT, CGNAT, a hotel network, or
a corporate firewall — with **no port forwarded, no dynamic DNS, no reverse proxy, and no tunnel
service holding a key to your machine**. If the laptop can reach `discord.com`, you can query it
from your phone.

Nothing listens. There is no inbound attack surface to add.

## What it can and cannot do

**Reads** — sessions, trajectories, raw event timelines, subagents, lineage.

**Writes** — register a workspace (`/dsh workspace`) and switch the default model (`/dsh model`).

**Runs work** — `/dsh run <prompt>` delivers a prompt to the workspace's agent and streams the turn
back. **This is off by default** (`allowRun: false`) because it is the one command that causes
work on your machine rather than describing it.

> **Read this before turning `allowRun` on.** With it enabled, everyone on `allowedUserIds` can
> make an agent edit files and run commands on the harness machine, from a phone. The allowlist
> stops being a privacy boundary and becomes a shell-access list. The bot does not weaken dsh's own
> sandbox or approval policy — whatever the harness would refuse locally it still refuses — but
> inside those limits, the agent acts. Keep the list to yourself, and prefer `ask` over
> `danger-full-access` as the permission preset if you enable this.

**Never** — it cannot bypass dsh's sandbox, approve on your behalf, or reach a session in another
workspace's channel.

## Channels are private

The category and its channels deny `@everyone` and grant only the bot and the people on
`allowedUserIds` — the guild owner alone when that list is empty. The same rule governs who may run
commands, so what a person can read and what they can ask never diverge.

Privacy is re-applied on **every** sync, not only at creation, so a category that already existed —
or one created before this was turned on — gets locked down rather than left as it is. If the bot
lacks *Manage Channels* it cannot restrict anything, and it says so loudly in the log and in
`/dsh sync` instead of leaving you to assume otherwise.

## Install

**1 — Create the bot.** At the [Discord Developer Portal](https://discord.com/developers/applications):
*New Application* → *Bot* → *Reset Token* and copy it. No privileged intents are needed — leave
Message Content **off**.

**2 — Invite it** to your server with the `bot` and `applications.commands` scopes:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=268487696&scope=bot+applications.commands
```

That number is *View Channels*, *Send Messages*, *Embed Links*, *Attach Files*, *Manage Channels*,
and *Manage Roles*. The last one is the non-obvious one: writing channel permission overwrites —
what makes the channels private — requires Manage Roles, and Discord reports its absence only as a
bare "Missing Access". Without it the bot still works, but the channels stay world-readable and it
says so on every sync.

**3 — Install into a dsh profile.** The setup script installs the package, writes the token to
`$DSH_HOME/discord-bot.token` (mode 600), and appends a row to the profile's patch layer. It asks
for anything you do not pass, and refuses without touching the profile if a row already exists:

```bash
git clone https://github.com/Oliver0804/dsh-discord-bot
cd dsh-discord-bot
npm install
node bin/setup.js --profile web
```

The setup script packs the checkout into a tarball, installs that into the profile, writes the
token, and appends the plugin row — see *Development* for why it installs a tarball rather than
linking the directory.

Non-interactive:

```bash
node bin/setup.js --profile web --guild 123456789012345678 --token "$TOKEN" --yes
```

Add `--print` to see the row it would write without changing anything.

Then restart dsh:

```bash
dsh --profile web
```

Open the new **dsh** category and run `/dsh status`.

### Manual install

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm add dsh-discord-bot
```

Append to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: discord-bot
      name: 'dsh-discord-bot'
      config:
        guildId: '123456789012345678'
        tokenFile: '/Users/you/.dsh/discord-bot.token'
        categoryName: 'dsh'
```

The plugin belongs to the **host** plane, not an agent preset: it serves every workspace and every
session, so a per-session copy would be wrong (and would collide on the second session).

## Commands

Run these inside a workspace channel. The `session` option is autocompleted — pick from a list of
recent sessions instead of typing a uuid — and defaults to the newest session in that workspace.

| Command | Answers |
|---|---|
| `/dsh sessions [limit]` | Sessions in this workspace: title, live or cold, age. |
| `/dsh trace [session] [limit] [everything]` | The trajectory — what was asked, answered, and which tools ran. |
| `/dsh timeline [session] [limit]` | The raw event timeline plus a type histogram. |
| `/dsh subagents [session] [deep]` | Subagents and whether each is **running** or inactive. |
| `/dsh run <prompt>` | Send work to the workspace's agent and watch the turn. Needs `allowRun`. |
| `/dsh lineage [session]` | Ancestor and descendant sessions. |
| `/dsh model [to]` | Show the default model, or switch it (autocompleted from the provider catalog). |
| `/dsh workspace <path>` | Register a directory as a workspace and give it a channel (path is autocompleted). |
| `/dsh status` | Mounted services, session counts, mapped workspaces. |
| `/dsh sync` | Re-sync the category, its channels, and their privacy now. |

`trace` reads the harness's own semantic-document projection, so reasoning blocks, stream chunks,
and structural boundaries are already filtered out. `everything: true` keeps the rest. Any answer
too large for one message spills into an attached `.txt` rather than being silently truncated.

`model` changes the deployment default, which applies to sessions created **from then on**; a
running session keeps the model it was created with. dsh's `saveSelection` is a silent no-op when
a profile has no settings provider, so the write is read back and a switch that did not persist is
reported as a failure rather than as success.

`workspace` takes an absolute path to an existing directory *on the harness machine* and syncs
immediately, so the new channel appears in the same breath. Its `path` is autocompleted against the
real filesystem — type a partial path to walk it, or a bare name to match directories sitting
alongside workspaces the harness already knows. Typing a full path on a phone is not a reasonable
thing to ask, and the harness resolves nothing relative to Discord.

Autocomplete answers only for people on the allowlist. Session titles and directory names are real
information about the machine, so the hints are gated exactly like the commands.

### Running work, and approvals

`run` continues the workspace's newest session — a live agent is used as-is, a cold one is resumed,
and a workspace with no session yet gets a fresh one rooted at its directory.

The turn is reported by rewriting one message every few seconds — Discord allows about five
messages per five seconds per channel, and a busy turn emits hundreds of events. Reasoning blocks
are dropped from the live view; `/dsh trace` has the full record afterwards.

`runVerbosity` decides what that message says. The default, `minimal`, shows one line naming the
tool in flight while it works, then the agent's closing words and a tool count when it lands — the
answer, not the process. `full` keeps the running transcript for when you are watching *how* a turn
works rather than waiting for what it concluded.

Resuming a cold session restores the conversation but not the agent: the model selection and the
preset that supplies its tools have to be reinstalled. This package does both. Skipping the preset
produces the most confusing failure available — the model, having no tool schemas, writes tool calls
as prose and nothing executes them.

When the harness asks for approval during such a turn, the bot posts a card with **Allow once** and
**Deny**, and three rules govern it:

- It answers **only** for turns started from Discord. A session you are driving in the web UI keeps
  being answered there.
- The clicker is checked against `allowedUserIds` — seeing the channel is not permission to approve.
- If nobody answers within two minutes it hands the question back to dsh rather than deciding.
  Timing out is not consent, and it is not refusal either.

### Chat mode

With `listenToMessages`, an ordinary message in a workspace channel becomes work — no slash command:

| Value | Behaviour |
|---|---|
| `off` *(default)* | Messages are ignored entirely; only `/dsh run` works. |
| `mention` | A message that @-mentions the bot is treated as a prompt. |
| `all` | Every message in a workspace channel is a prompt. |

Chat mode also requires `allowRun`, and it needs the **Message Content** privileged intent, which
you must enable first under *Bot → Privileged Gateway Intents* in the Developer Portal. Discord
refuses the entire connection when an application requests an intent it has not enabled, so the bot
only asks for it when this is set — and if it is refused anyway, the bot stops and says which of the
two fixes applies instead of retrying forever.

Declined messages are ignored silently. This handler sees every message in the guild, so answering
the ones it rejects would turn ordinary conversation into a stream of refusals — and telling an
unauthorized member that they are unauthorized only advertises that the bot is worth probing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `guildId` | *required* | The one guild this bot serves. Interactions elsewhere are ignored. |
| `token` | — | Bot token inline. Prefer `tokenFile`. |
| `tokenFile` | — | File whose first non-comment line holds the token. |
| `categoryName` | `dsh` | Category that holds the workspace channels. |
| `allowedUserIds` | `[]` | Discord user ids allowed to query. **Empty means the guild owner alone.** |
| `manageChannels` | `true` | Whether the bot may create and rename the category and channels. |
| `privateChannels` | `true` | Deny `@everyone` and grant only the bot and `allowedUserIds`. |
| `allowRun` | `false` | Enable `/dsh run`. **Grants the allowlist agent execution on this machine.** |
| `listenToMessages` | `off` | `off` / `mention` / `all` — treat channel messages as prompts. Needs `allowRun` and the Message Content intent. |
| `runVerbosity` | `minimal` | `minimal` shows the answer; `full` streams the whole transcript. |
| `followNewWorkspaces` | `true` | Create a channel when a session appears for an unmapped workspace. |
| `traceLimit` | `25` | Default entries per `/dsh trace`. |
| `sessionLimit` | `15` | Default sessions per `/dsh sessions`. |
| `retrySeconds` | `30` | Delay between Discord login retries. |

The token may also come from `DSH_DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN`. Precedence is
`token` → `tokenFile` → environment.

## Security

- **One guild.** Interactions from any other guild are dropped before authorization runs.
- **Allowlist.** An empty `allowedUserIds` authorizes the guild owner only — never the whole
  server. Add ids to widen it deliberately. The same list gates channel visibility.
- **Private channels by default.** `@everyone` is denied; only the bot and the allowlist can read.
- **No privileged intents.** Only `Guilds`. The bot cannot read anyone's messages.
- **Session text is neutralized** before it enters a message: code fences cannot break out and
  mentions cannot ping the server.
- **No execution unless you ask for it.** `allowRun` is off by default; with it off, nothing here
  can run a command or drive an agent. With it on, the allowlist is a shell-access list — see the
  warning at the top.
- **Approval is never automatic.** The bot cannot approve on your behalf, and a card that times out
  is handed back to dsh rather than decided.

### Where the token lives

The token belongs in `$DSH_HOME/discord-bot.token`, written mode 600 by the setup script — never in
this repository and never in a committed profile. `.gitignore` blocks `.env`, `*.token`, and
`*.secret` as a backstop, but the real protection is that the file lives outside the tree entirely.
The plugin row references it by path.

If a token is ever pasted into a shell, a chat, or a commit, treat it as burned: reset it in the
Developer Portal and rewrite the token file. A leaked bot token lets anyone read every channel the
bot can see.

### If the category already exists and is already private

A fresh install needs no manual permission work: the bot creates the category itself and writes its
own access in at creation, so the category is private, the bot can see it, and every channel under
it inherits both.

The one case that breaks is a category that was **made private by hand before the bot was
introduced**, with no exception for the bot. The bot is then locked out of the channel tree it is
supposed to manage — it cannot restrict channels, cannot create new ones there, and cannot receive
messages for chat mode. Slash commands still work, because an interaction carries its own token.

The invite URL cannot fix this. `permissions=` grants guild-level permissions, and a channel
overwrite beats a guild-level permission; the only thing that bypasses overwrites is
`Administrator`, which is far too much to hand a bot for this. Pick one instead:

- **Grant it once** — category → *Edit Category* → *Permissions* → add the bot, allow *View
  Channel*. Existing channels and their history are kept, and the bot takes over from there.
- **Let the bot start clean** — point `categoryName` at a name that does not exist yet, and the
  next sync builds a correct one. The old channels stay where they are.

After either, `/dsh sync` reports `🔒 private` without the "set outside the bot" note, which is how
you know the bot is managing it rather than merely observing it.

## Behaviour worth knowing

- **A failure never takes dsh down.** A bad token, a revoked permission, or no network logs a
  warning and retries; the harness boots and runs regardless. This matters because Cordis treats an
  activation throw as a failed composition — `dsh-host-webserver` genuinely stops the process when
  its port is taken, and a chat bridge must not behave that way.
- **Channels are never deleted.** A workspace removed from dsh leaves its channel and history in
  place; `/dsh status` reports the leftovers.
- **The mapping lives in the channel topic** (`[dsh:<workspaceId>] …`), not in memory, so it
  survives restarts and channel renames. Clear the topic to unmap a channel.
- **Discord caps a category at 50 channels.** Beyond that, workspaces stay unmapped and the
  overflow is logged rather than silently dropped.
- **Without `ctx.workspaceRegistry`** — the tui and headless profiles do not mount it — workspaces
  are grouped by session `cwd` instead. Everything else works the same.
- **Upgrading the package needs a dsh restart.** dsh's HMR reloads the *composition*, so adding the
  plugin row activates the bot in a running harness without one — but Node has already cached the
  module, so a later `pnpm add` of a new version does not take effect until the process restarts.
  A harness left running will keep answering with the version it first loaded.
- **Never run two harnesses on one bot token.** Discord delivers each interaction to exactly one
  connected session, so two instances answer at random: half the commands hit the older build and
  the other half fail with "Unknown interaction". Give a second harness its own bot application.

## Requirements

- dsh `0.1.0-rc.6` or newer, with `sessionQuery` composed (every profile built on `dsh-base` has it)
- Node.js 20+

## Development

**There is no build step.** The package ships the JavaScript it runs: plain ESM, no TypeScript, no
bundler, no transpile. `lib/` is the source and the published artifact both, so what you read is
what executes inside dsh.

```bash
git clone https://github.com/Oliver0804/dsh-discord-bot
cd dsh-discord-bot
npm install       # discord.js only
npm test          # 22 unit tests — no network, no harness, no Discord account
```

Layout:

| File | Role |
|---|---|
| `lib/index.js` | Cordis plugin entry: lifecycle, connection, retry, logging |
| `lib/config.js` | Config validation and token resolution |
| `lib/workspaces.js` | Workspace view — registry, or cwd grouping as fallback |
| `lib/queries.js` | Every harness read and the two writes |
| `lib/render.js` | Discord embeds, size limits, attachment overflow |
| `lib/topology.js` | Category/channel reconciliation and privacy |
| `lib/commands.js` | Slash command definitions |
| `lib/router.js` | Interaction routing, authorization, autocomplete |
| `bin/setup.js` | Installer |

To test against a live harness without touching your own profile, install the packed tarball and
boot a second instance with an overlay patch on another port:

```bash
npm pack
(cd "${DSH_HOME:-$HOME/.dsh}/profiles/web" && pnpm add /path/to/dsh-discord-bot-0.1.0.tgz)
dsh --profile web --patch ./my-test-patch.yml --port 3099
```

Install the packed tarball rather than linking the source directory: a linked package resolves its
own `node_modules`, which would bind the plugin against a **second copy** of the harness's packages
— a different class identity than the host holds, and a failure that surfaces as a plugin that
silently never registers. This package imports nothing from `@deepseek-ai/*` for the same reason;
its only contact with the harness is the `ctx` object handed to `apply`.

## License

MIT
