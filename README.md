# opencode-session-overview

A Codex-style session overview for OpenCode Desktop, as a native side panel
instead of a composer pill.

## What it shows

- **Project** — project name, current branch, directory
- **Timing** — cumulative session throughput and wait time, with a tightly
  spaced current/last-run breakdown above the cumulative breakdown (model,
  shell, tools and other). The current/last-run row is green while running and
  orange while waiting for input; **Details** opens the full list, including
  waiting on you and provider retry, plus a **Show all turns** switch
- **Changes** — working-tree additions/deletions from `vcs.status`; click for
  the per-file list
- **Subagents** — child sessions with colored initials, running/done counts,
  and click-through to the child session
- **Sources** — configured MCP servers, Web search, connected integrations, and
  references; `+` opens Settings, and “View all” lists everything

It is a normal side-panel tab. It opens automatically the first time a primary
session becomes active in a window. Closing it is respected for that session
until the window reloads. You can also open it from the panel **+** menu under
**Overview**, or run `/overview`. It can be dragged to the bottom pane like any
other panel tab.

## Install

Add the package to the global desktop plugin config, then build it:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    {
      "package": "file:///Users/olasundell/code/own/opencode-session-overview"
    }
  ]
}
```

```sh
cd /Users/olasundell/code/own/opencode-session-overview
pnpm install
pnpm build
```

OpenCode Desktop reads `opencode.json(c)`; TUI-only entries in `cli.json` do
not load here. Rebuilding `dist/gui-experimental.cjs` reloads the GUI in every
window.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "file:///Users/olasundell/code/own/opencode-session-overview",
      "options": {
        "autoOpen": true
      }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `autoOpen` | `true` | Open the Overview panel on the first active visit to each primary session in a window |

## Scope

This is the side-panel option, not the floating top-right card. The desktop GUI
SDK has no top-right slot; the supported surfaces are `session.header`,
`session.location.menu`, `session.panel.end`, `window.bottom`, side panels, and
dialogs. A floating card would need a fixed-position overlay and is a separate
experiment.

The timing row reuses the measurement rules from `opencode-turn-meter`:
provider-active time is `created → streamed`, tool time is the union of tool
intervals, and wait time is turn wall clock minus model request time. Cumulative
figures sum the individual turns, so idle gaps between turns are excluded. The
panel recomputes it every two seconds while a turn runs.

## Development

```sh
pnpm check   # typecheck, unit tests, GUI bundle
```

The GUI part is experimental and targets OpenCode `>=2.2.6 <3`.
