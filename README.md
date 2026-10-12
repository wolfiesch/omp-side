# omp-side

`/side` for [Oh My Pi](https://github.com/can1357/oh-my-pi), with native launch adapters for [cmux](https://cmux.com), tmux, [Tern](https://stencil.so/tern), WezTerm, Kitty, and Ghostty.

Fork the conversation you are in right now, at this exact point, and open the fork nearby. Ask the tangent there. Your main thread stays clean.

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

The extension creates a real child `omp` session before opening it nearby. The child gets the whole
transcript, its own session file, and `parentSession` lineage, but not the parent's active todo list.
A fork-boundary instruction keeps earlier work assigned to the concurrently running parent. Nothing
the child does can affect the main conversation unless you ask for its first answer with `--pull`.

## Requirements

- `omp` (Oh My Pi) with session persistence on, so not `--no-session`
- One supported terminal environment:
  - cmux
  - tmux
  - Tern, with the `tern` CLI on `PATH` or Tern.app in `/Applications`
  - WezTerm with `wezterm cli`
  - Kitty with remote control available through `kitten @`
  - Ghostty on macOS or Linux
- macOS or Linux

## Install

```sh
omp plugin install github:wolfiesch/omp-side
```

Restart omp. Extensions load at startup, so the session you are in when you install will not have `/side` yet.

Prefer a checkout? Clone the repository and symlink its entry module instead. Keep
`side-management.ts` alongside `index.ts` in the checkout:

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
/side --split -- <prompt>               force a split even when no pane has room
/side --down -- <prompt>                split below only
/side --pull -- <prompt>                deliver the fork's first answer back here
/side list                              list this session's forks and pane status
/side focus 2                           switch to fork 2
/side close 2                           confirm closing fork 2; keep its transcript
/side --model @slow --thinking high -- <prompt>
                                         fork with a different model and reasoning level
```

| Flag | Effect |
|---|---|
| `--bg` | Do not steal focus. |
| `--tab` | Force a new terminal tab. In tmux this is a new window. |
| `--split` | Split even when no pane meets the minimum size; without a fit, your pane splits along its better axis. |
| `--left` `--right` `--up` `--down` | Split in that direction only. The same size search runs on that axis; without a fit, your pane splits anyway. |
| `--pull` | Watch the fork and attach its first answer to your next message here. |
| anything else | Passed through to `omp`, so `--model`, `--thinking`, `--tools`, and friends all work. |

Use `--` to separate flags from the prompt. Without it, a leading `list`, `focus`, or `close`
selects a management command; a leading `-` means flags only; anything else is the prompt.
For a prompt starting with a reserved word, write `/side -- list the possible causes`.

`alt+s` is bound to an empty focused fork using automatic placement.

Typing `/side ` opens argument completion. Continue with `--m` to choose from authenticated models or
role aliases such as `@smol` and `@slow`; `--thinking` offers the supported CLI reasoning levels.
Choose `--` when you are ready to type the prompt. Earlier options remain intact as each completion
is accepted, so the whole launch can be built without memorizing flag values.

### Managing forks

Use `/side list` to see stable fork numbers, prompts, terminal names, and pane status. Numbers
remain assigned after a pane closes and across parent-session restarts. A child session starts
its own fork list rather than inheriting control of its parent's other forks.

Use `/side focus N` to switch to a live fork. Use `/side close N` to close its pane after a
confirmation. Closing terminates any running process in that pane; the transcript remains on
disk. Terminal identity and live pane state are checked again after confirmation.

Management is available in tmux, Tern, WezTerm, Kitty, and cmux. In tmux, Tern, and Kitty, the
launch or process arguments must still name the recorded child session. WezTerm and cmux do not
expose that check through these adapters, so validation uses the terminal scope and exact pane
identity. Direct Ghostty windows cannot be focused or closed through `/side`.

Older forks without recorded child identity appear as `unverified` and cannot be focused or
closed. Missing panes appear as `gone`; inaccessible terminals appear as `unavailable`. Neither
case causes a command to target the current pane instead.

### Automatic placement

In tmux, Tern, and WezTerm, `/side` reads each pane's size and splits only where both halves stay at
least 80 columns wide and 30 rows tall.

1. **Keep repeat forks together.** If an automatically placed fork from this parent is still
   in the same tab, stack the next fork below a member of that group. The parent pane stays
   unchanged. When no group member has room for another stacked split, use a new tab.
2. **Otherwise, your pane first.** Split along whichever permitted axis leaves the roomier
   halves on screen. Wide panes go side by side, tall panes stack, and ties go side by side.
3. **Another pane only when yours is too small.** In tmux, prefer a fitting pane that shares an
   edge with yours before considering more distant panes. Within either group, choose the
   roomiest split, preferring the largest pane on ties. Corner-only contact is not adjacency.
4. **A new tab** when nothing fits.

Only live tiled panes in the current tab qualify for grouping; closed and moved-away panes do
not. The first split remains size-aware, so a tall parent can begin a group below itself rather
than to its right. Grouping applies to automatic forks recorded from version 0.5.0 onward.

Explicit `--tab`, `--split`, and direction flags bypass grouping. Direction flags restrict the
search to that direction. `--split` without a fit divides your pane along its better axis.

Screen shape depends on the font: a cell is roughly twice as tall as it is wide, and the exact
ratio varies by font and size. Tern reports each pane's pixel size, so `/side` uses your actual
cell shape there. tmux and WezTerm placement assumes a 2:1 cell.

Only the pane selected for a split is divided; unrelated panes are not rearranged. Tern
picture-in-picture panes are excluded. Set `OMP_SIDE_MIN_COLS` and `OMP_SIDE_MIN_ROWS` to change the minimum;
a value that is not a positive whole number fails the command with the variable's name.

The cmux and Kitty adapters retain the simpler pane-count rule: a one-pane tab gets one split,
and an already split tab gets a new tab. Repeat-fork grouping is available in tmux, Tern, and WezTerm.

## What `--pull` does

The side session runs on its own. With `--pull`, this extension tails the fork's session file, and
the first assistant answer it produces is queued into your main session as context attached to your
next message. It is one shot. The watcher stops after that answer, after 30 minutes, or if the fork
never appears within a minute.

Everything stays local. The watcher reads a file on disk and nothing else.

## Terminal support

| Environment | Automatic placement | Explicit controls |
|---|---|---|
| cmux | Split a one-pane workspace; otherwise a new terminal surface tab in the current pane | Exact tab and split direction |
| tmux | Size-aware split of any pane in the window; otherwise a new tmux window | Exact window and split direction |
| Tern | Size-aware split of any tiled pane in the tab; otherwise a new tab in the current session | Exact tab and split direction |
| WezTerm | Size-aware split of any pane in the tab; otherwise a new tab | Exact tab and split direction |
| Kitty | New Kitty window in a one-window tab; otherwise a new tab | Tab or split axis; Kitty's active layout decides final ordering |
| Ghostty directly | New OS window | Ghostty does not expose stable cross-platform tab or split control |

cmux embeds Ghostty but is detected first, so an OMP process inside cmux gets cmux panes and tabs.
tmux is detected before Tern, so tmux running inside a Tern pane gets tmux panes and windows.
Tern opens forks without moving focus and then focuses the fork unless `--bg` is set. Left and up
splits are a right or down split followed by `tern move`, because `tern split` only goes right or
down.
Direct Ghostty uses a separate window without keyboard simulation or accessibility scripting.
Unsupported terminals fail visibly instead of typing a command into an unknown UI.

## How it works

1. `ctx.sessionManager.getSessionFile()` gives the live session's `.jsonl` path.
2. The extension detects the innermost supported multiplexer or terminal from its environment.
3. The adapter reads the current tab's panes (with sizes where the terminal reports them) and
   selects a split target and direction, or a tab.
4. The extension forks the transcript into a new session file, recording `parentSession` and
   `providerPromptCacheKey` pointing at the parent.
5. It pairs unresolved tool calls at the copied turn's tail with explicit unknown-outcome error
   results, then appends an empty todo snapshot and a hidden tangent boundary. Completed results
   and the parent's transcript remain unchanged.
6. The adapter starts `omp --cwd <cwd> --resume <child-session.jsonl> [your flags] [your prompt]`.

Every argument stays separate for Tern, WezTerm, Kitty, and Ghostty. cmux and tmux require one POSIX
shell command string, so each argument is single-quoted independently before launch.

A spawn is recorded in the parent transcript as a custom entry of type `omp-side.spawn`, including
the selected terminal, placement, target, child session file, and terminal routing identity.
Management and repeat-fork grouping use these entries. Confirmed closes are recorded as
`omp-side.closed`; transcripts are never deleted by a close command.

The boundary is re-injected after child-session compaction. Parent todos therefore remain context,
not child obligations, and an incomplete-todo reminder cannot resume the parent's work.

## Known limits

- **Forking a large session is not free.** Some providers re-read the whole context on the fork's
  first turn rather than hitting a warm prompt cache. Check the token counter before forking a very
  long conversation, and consider `--model @smol` for cheap tangents.
- **Startup takes ten to fifteen seconds**, almost all of it MCP servers reconnecting in the new
  process. There is currently no way to start an omp session with MCP disabled.
- **Mid-turn forks are snapshots.** Pending tool calls at the fork boundary receive explicit
  unknown-outcome error results in the child. The parent may still finish those tools, but its
  later results do not automatically appear in the fork.
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
