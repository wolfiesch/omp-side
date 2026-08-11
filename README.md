# omp-side

`/side` for [Oh My Pi](https://github.com/can1357/oh-my-pi), with native launch adapters for
[cmux](https://cmux.com), tmux, WezTerm, Kitty, and Ghostty.

Fork the conversation you are in right now, at this exact point, and open the fork nearby. Ask the
tangent there. Your main thread stays clean.

```
/side why would that cache miss?
```

```
┌────────────────────────────┬────────────────────────────┐
│ main session               │ ⑂ why would that cache…    │
│                            │                            │
│ > /side why would that…    │ full transcript up to the  │
│   side session forked      │ moment you typed /side,    │
│   into surface:142         │ now a separate session     │
│                            │ you can keep talking to    │
└────────────────────────────┴────────────────────────────┘
```

The fork is a real `omp` process started with `omp --fork <session.jsonl>`. It gets the whole
transcript, its own session file, and `parentSession` recorded for lineage. Nothing it does can
touch your main conversation unless you ask for it with `--pull`.

## Requirements

- `omp` (Oh My Pi) with session persistence on, so not `--no-session`
- One supported terminal environment:
  - cmux
  - tmux
  - WezTerm with `wezterm cli`
  - Kitty with remote control available through `kitten @`
  - Ghostty on macOS or Linux
- macOS or Linux

## Install

```sh
omp plugin install github:wolfiesch/omp-side
```

Restart omp. Extensions load at startup, so the session you are in when you install will not have
`/side` yet.

Prefer a plain file? Clone anywhere and symlink the single module instead:

```sh
git clone https://github.com/wolfiesch/omp-side.git
ln -s "$PWD/omp-side/index.ts" ~/.omp/agent/extensions/omp-side.ts
```

Use one method or the other. Both at once registers the command twice.

## Usage

```
/side <prompt>                          auto-place the fork and ask
/side                                   auto-place an empty side session
/side --bg -- <prompt>                  open without taking focus
/side --tab -- <prompt>                 force a new terminal tab
/side --split -- <prompt>               force another split
/side --down -- <prompt>                force a split below
/side --pull -- <prompt>                deliver the fork's first answer back here
/side --model @slow -- <prompt>         fork into a different model
```

Automatic placement keeps layouts bounded: a one-pane terminal gets one split; if that tab or
workspace is already split, `/side` opens a new tab instead of subdividing it again.

| Flag | Effect |
|---|---|
| `--bg` | Do not steal focus. |
| `--tab` | Force a new terminal tab. In tmux this is a new window. |
| `--split` | Force another split even when the current layout is already split. |
| `--left` `--right` `--up` `--down` | Force a split in that direction. Default direction is `--right`. |
| `--pull` | Watch the fork and attach its first answer to your next message here. |
| anything else | Passed through to `omp`, so `--model`, `--thinking`, `--tools`, and friends all work. |

`--` separates flags from the prompt. Without it the whole argument string is the prompt, unless it
starts with `-`, in which case it is all flags and the fork opens empty.

`alt+s` is bound to an empty focused fork using automatic placement.

## What `--pull` does

The side session runs on its own. With `--pull`, this extension tails the fork's session file, and
the first assistant answer it produces is queued into your main session as context attached to your
next message. It is one shot. The watcher stops after that answer, after 30 minutes, or if the fork
never appears within a minute.

Everything stays local. The watcher reads a file on disk and nothing else.

## Terminal support

| Environment | One-pane default | Already-split default | Explicit controls |
|---|---|---|---|
| cmux | New split | New terminal surface tab in the current pane | Exact tab and split direction |
| tmux | New pane | New tmux window | Exact window and split direction |
| WezTerm | New pane | New tab | Exact tab and split direction |
| Kitty | New Kitty window in the current tab | New tab | Tab or split axis; Kitty's active layout decides final ordering |
| Ghostty directly | New OS window | New OS window | Ghostty does not expose stable cross-platform tab or split control |

cmux embeds Ghostty but is detected first, so an OMP process inside cmux gets cmux panes and tabs.
Direct Ghostty uses a separate window without keyboard simulation or accessibility scripting.
Unsupported terminals fail visibly instead of typing a command into an unknown UI.

## How it works

1. `ctx.sessionManager.getSessionFile()` gives the live session's `.jsonl` path.
2. The extension detects the innermost supported multiplexer or terminal from its environment.
3. The adapter counts panes in the current tab or workspace and selects a split or tab.
4. The adapter starts `omp --cwd <cwd> --fork <session.jsonl> [your flags] [your prompt]`.
5. `omp --fork` copies the transcript into a new session file and records `parentSession` and
   `providerPromptCacheKey` pointing at the parent.

Every argument stays separate for WezTerm, Kitty, and Ghostty. cmux and tmux require one POSIX shell
command string, so each argument is single-quoted independently before launch.

A spawn is recorded in the parent transcript as a custom entry of type `omp-side.spawn`, including
the selected terminal, placement, and target. The branch point stays visible in session history and
HTML exports.

## Known limits

- **Forking a large session is not free.** Some providers re-read the whole context on the fork's
  first turn rather than hitting a warm prompt cache. Check the token counter before forking a very
  long conversation, and consider `--model @smol` for cheap tangents.
- **Startup takes ten to fifteen seconds**, almost all of it MCP servers reconnecting in the new
  process. There is currently no way to start an omp session with MCP disabled.
- **Forking mid-turn leaves a scar.** If the main agent is running when you type `/side`, the
  transcript tail contains an unfinished tool call, and the fork opens with a warning that the
  previous session ended with a pending call. Harmless, and it goes away if you fork while idle.
- **A brand new session has nothing to fork.** Until a session writes its first entries to disk it
  has no file, and `/side` will say so instead of silently opening an unrelated blank session.
- **The last moments of an in-flight turn may not be on disk.** Extensions cannot force a session
  flush, so a fork taken mid-turn can miss a tool result that has not been written yet.
- **`alt+s` is unverified.** It is registered, but it could not be exercised through scripted key
  injection, so confirm it by hand.
- **Kitty remote control is configuration-dependent.** If `kitten @ ls` is denied, enable Kitty
  remote control using Kitty's documented permission controls. `/side` reports the CLI error.
- **Direct Ghostty cannot inspect or modify the current tab layout.** Its supported fallback is a
  new OS window. Use cmux or tmux inside Ghostty for automatic split and tab placement.

## Uninstall

```sh
omp plugin uninstall omp-side
```

Or remove the symlink if you installed it that way.

## License

MIT
