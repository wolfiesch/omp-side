# omp-side

`/side` for [Oh My Pi](https://github.com/can1357/oh-my-pi) running inside [cmux](https://cmux.com).

Fork the conversation you are in right now, at this exact point, and drop the fork into a live
terminal beside you. Ask the tangent there. Your main thread stays clean.

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
- `cmux` on `PATH`, and the omp session running inside a cmux terminal
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
/side <prompt>                          fork, open a split on the right, focus it, ask
/side                                   fork into an empty side session, focus it
/side --bg -- <prompt>                  same, but keep focus where it is
/side --tab -- <prompt>                 fork into its own cmux tab instead of a split
/side --down -- <prompt>                split below instead of right
/side --pull -- <prompt>                deliver the fork's first answer back to this session
/side --model @slow -- <prompt>         fork into a different model
```

| Flag | Effect |
|---|---|
| `--bg` | Do not steal focus. Focus returns to wherever it was. |
| `--tab` | New cmux workspace instead of a split in this one. |
| `--left` `--right` `--up` `--down` | Split direction. Default `--right`. |
| `--pull` | Watch the fork and attach its first answer to your next message here. |
| anything else | Passed through to `omp`, so `--model`, `--thinking`, `--tools`, and friends all work. |

`--` separates flags from the prompt. Without it the whole argument string is the prompt, unless it
starts with `-`, in which case it is all flags and the fork opens empty.

`alt+s` is bound to an empty focused fork.

## What `--pull` does

The side session runs on its own. With `--pull`, this extension tails the fork's session file, and
the first assistant answer it produces is queued into your main session as context attached to your
next message. It is one shot. The watcher stops after that answer, after 30 minutes, or if the fork
never appears within a minute.

Everything stays local. The watcher reads a file on disk and nothing else.

## How it works

1. `ctx.sessionManager.getSessionFile()` gives the live session's `.jsonl` path.
2. `cmux new-split <direction>` creates the pane and returns its surface ref.
3. `cmux respawn-pane --command` replaces that pane's shell with
   `exec omp --cwd <cwd> --fork <session.jsonl> [your flags] [your prompt]`.
4. `omp --fork` copies the transcript into a new session file and records `parentSession` and
   `providerPromptCacheKey` pointing at the parent.

A spawn is recorded in the parent transcript as a custom entry of type `omp-side.spawn`, so the
branch point stays visible in the session history and in HTML exports.

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

## Uninstall

```sh
omp plugin uninstall omp-side
```

Or remove the symlink if you installed it that way.

## License

MIT
