# Screenshots

Captured 2026-08-15 against a live install: dsh `web` profile, `dsh-discord-bot` 0.2.7,
Discord web, `zh-Hant` locale.

The run registers a new workspace and drives it, end to end, from Discord alone.

Post-processed for publication: Discord's server rail and channel sidebar are cropped away,
and every absolute filesystem path is pixelated. The project's own
`github.com/Oliver0804/dsh-discord-bot` footer is deliberately left readable.

| File | Shows |
|---|---|
| `01-command-palette.jpg` | Typing `/dsh` — the whole command surface with its descriptions. |
| `02-status.jpg` | `/dsh status`: mounted harness services, session counts, and every workspace mapped to a channel. |
| `03-workspace-autocomplete-default.jpg` | `/dsh workspace` with an empty `path` — directories sitting alongside workspaces the harness already knows. |
| `04-workspace-autocomplete-path.jpg` | The same autocomplete walking a real filesystem path down to one match. |
| `05-workspace-registered.jpg` | The registration card: name, path, session count, and the channel it just created. |
| `06-new-channel-in-sidebar.jpg` | The registration landing, with the new channel created in the `dsh` category. |
| `07-new-channel-help.jpg` | The fresh channel — private (lock badge), workspace id in the topic — answering `/dsh help`. |
| `08-run-running.jpg` | `/dsh run` mid-turn: the live card naming the tool in flight, with Trace / Timeline / Subagents / Todos / Export and the Steer / Stop row. |
| `09-run-complete.jpg` | The same card rewritten on landing: the agent's answer and a tool count. |
| `10-trace-ephemeral.jpg` | The **Trace** button's private reply — tool calls, results, the agent's turn, and a stats footer (steps, LLM vs tool time, tok/s, cache hit rate, tokens). |
| `11-menu.jpg` | `/dsh menu` — one card whose dropdowns reach everything without typing. The new workspace now owns the session the run created. |
| `12-menu-dropdown.jpg` | That card's session dropdown open. |

Sizes: `01`/`02` are 1216×785, `10` is 1065×779, the rest 1065×723 — the browser window was
resized between shots.

## Still visible

Cropping and masking covered the sidebar and the paths. These remain, and are fine to publish
unless you would rather they weren't: the guild name (`BASHCAT`, in the header and the search
box), channel names, workspace and session ids (`[dsh:…]`, `session cb1fb432`), and the bot's
own avatar and name.
