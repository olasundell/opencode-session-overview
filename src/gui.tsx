/** @jsxImportSource solid-js */
import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  usePlugin,
  type IconName,
  type MenuItem as MenuItemInfo,
  type MountedSession,
  type PanelProps,
  type PanelTab,
  type UiMenuEntry,
} from "@opencode/plugin/gui"
import type { SessionInfo, VcsFileStatus } from "@opencode/client"
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js"
import type { JSX } from "solid-js"
import { summarizeContext } from "./context.js"
import {
  avatarColor,
  basename,
  descendantIDs,
  initials,
  sumChanges,
} from "./overview.js"
import {
  formatDuration,
  formatRate,
  formatShortDuration,
  formatTokens,
  type SessionSummary,
  type TurnSummary,
} from "./turn.js"
import { createTimingTracker, type TimingSubscribe } from "./timing.js"

type SourceTone = "success" | "warning" | "danger"

type Source = {
  readonly id: string
  readonly name: string
  readonly icon: IconName
  readonly detail?: string
  readonly tone?: SourceTone
}

type TimingRow = {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly tone?: "warning"
}

// Auto-open once per session in this window. Closing the panel afterwards is
// respected until the window or plugin reloads.
const autoOpened = new Set<string>()

export default Plugin.define({
  i18n: {
    en: {
      "panel.title": "Overview",
      "command.overview": "Show session overview",
      "menu.actions": "Overview actions",
    },
  },
  setup(ctx) {
    const options = {
      autoOpen: ctx.options.autoOpen !== false,
    }

    const tab: PanelTab = {
      id: "overview",
      get title() {
        return ctx.t("panel.title")
      },
      closable: "compact",
      fallback: true,
    }

    ctx.add(Panel, {
      id: "overview",
      region: "side",
      width: 320,
      mobile: {
        get title() {
          return ctx.t("panel.title")
        },
        order: 40,
        kind: "menu",
        icon: "window-analytics",
      },
      list: (input) => (input.open.includes("overview") ? [tab] : []),
      render: (props) => <Overview {...props} />,
    })

    ctx.add(Slot, {
      at: "session.header",
      render: (input) => (
        <AutoOpen
          session={input.session}
          active={input.active}
          enabled={options.autoOpen}
        />
      ),
    })

    ctx.add(MenuItem, (): MenuItemInfo => {
      const session = ctx.sessions.current()

      return {
        menu: "session.panel",
        id: "overview",
        title: ctx.t("panel.title"),
        icon: "window-analytics",
        opened: !!session && ctx.layout.state(`${ctx.id}:overview`, session) !== "closed",
        run: () => {
          const current = ctx.sessions.current()
          if (current) ctx.layout.open(`${ctx.id}:overview`, current, { tab: "select" })
        },
      }
    })

    ctx.add(Command, () => ({
      id: "overview",
      title: ctx.t("command.overview"),
      slash: { name: "overview" },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        ctx.layout.open(`${ctx.id}:overview`, session, { tab: "select" })
      },
    }))
  },
})

function AutoOpen(props: {
  readonly session: MountedSession
  readonly active: boolean
  readonly enabled: boolean
}) {
  const ctx = usePlugin()

  createEffect(() => {
    if (!props.enabled || !props.active) return

    const session = props.session
    if (!session || session.pending) return

    const store = session.server.data
    try {
      if (store.session.root(session.id) !== session.id) return
    } catch {
      return
    }

    // On a narrow window the host gives the side region the whole screen.
    if (ctx.layout.narrow()) return
    if (autoOpened.has(session.key)) return

    autoOpened.add(session.key)

    try {
      // `background` opens the side region for an action the user did not
      // start from the panel, without replacing a narrow-screen view.
      ctx.layout.open(`${ctx.id}:overview`, session, {
        tab: "select",
        background: true,
      })
    } catch {
      autoOpened.delete(session.key)
    }
  })

  return null
}

/**
 * Track every turn for this panel's session. Persisted messages supply steps,
 * tokens and tool times; live events supply streaming deltas, permission/form
 * waits and retry waits.
 */
function useTurnTiming(session: MountedSession) {
  const [tick, setTick] = createSignal(0)

  let tracker: ReturnType<typeof createTimingTracker> | undefined

  createEffect(() => {
    const store = session.server.data
    const sessionID = session.id

    tracker = createTimingTracker({ sessionID })

    const off = tracker.attach(store.on as unknown as TimingSubscribe)
    const timer = setInterval(() => setTick((value) => value + 1), 2000)

    // Show the summary once the tracker exists, not only after two seconds.
    setTick((value) => value + 1)

    onCleanup(() => {
      off()
      clearInterval(timer)
      tracker = undefined
    })
  })

  return createMemo(() => {
    tick()

    // Read the store outside the reactive graph: only the two-second tick
    // should recompute the timing row, not every streaming event.
    return untrack(() => {
      const store = session.server.data
      const running = store.session.status(session.id) === "running"

      return tracker?.snapshot(store.session.message.list(session.id), Date.now(), running)
    })
  })
}

function timingRows(summary: TurnSummary): TimingRow[] {
  const rows: TimingRow[] = [
    { id: "rate", label: "Throughput", detail: formatRate(summary.rate) },
    { id: "tokens", label: "Tokens", detail: formatTokens(summary.tokens) },
    { id: "model", label: "Model request", detail: formatDuration(summary.modelMs) },
    {
      id: "shell",
      label: `Shell (${summary.shellCount})`,
      detail: formatDuration(summary.shellMs),
    },
    {
      id: "plugins",
      label: `Plugins/MCPs (${summary.pluginCount})`,
      detail: formatDuration(summary.pluginMs),
    },
  ]

  for (const tool of summary.tools.slice(0, 2)) {
    rows.push({
      id: `tool:${tool.name}`,
      label: tool.name,
      detail: `${formatDuration(tool.ms)} · ${tool.count}×`,
    })
  }

  if (summary.humanMs > 0) {
    rows.push({
      id: "human",
      label: `Waiting on you (${summary.humanCount})`,
      detail: formatDuration(summary.humanMs),
      tone: "warning",
    })
  }

  if (summary.retryMs > 0) {
    rows.push({
      id: "retry",
      label: "Provider retry",
      detail: formatDuration(summary.retryMs),
      tone: "warning",
    })
  }

  rows.push({ id: "other", label: "Other", detail: formatDuration(summary.otherMs) })

  rows.push({ id: "wait", label: "Total wait", detail: formatDuration(summary.waitMs) })
  rows.push({ id: "turn", label: "Total time", detail: formatDuration(summary.totalMs) })

  return rows
}

function Overview(props: PanelProps) {
  const ctx = usePlugin()
  const data = () => props.session.server.data
  const directory = () => props.session.directory
  const timing = useTurnTiming(props.session)
  const [allTurns, setAllTurns] = createSignal(false)

  const waitingOnYou = createMemo(() => {
    const summary = timing()?.summary
    if (summary && summary.pendingHumanMs > 0) return true

    return untrack(() => {
      const store = data()
      if (store.session.permission.list(props.session.id).length > 0) return true

      return (
        (store.session.form.list(props.session.id, props.session.location) ?? []).length >
        0
      )
    })
  })

  const timingTone = createMemo<"success" | "warning">(() =>
    timing()?.summary.running && !waitingOnYou() ? "success" : "warning",
  )

  const context = createMemo(() => {
    // Recompute on the same two-second cadence as the timing row.
    timing()

    return untrack(() => {
      const store = data()
      const messages = store.session.message.list(props.session.id)
      const info = store.session.get(props.session.id)
      const ref =
        info?.model ??
        messages.findLast((message) => message.type === "assistant")?.model
      const model = ref
        ? (store.location.model.list(props.session.location) ?? []).findLast(
            (item) =>
              item.providerID === ref.providerID &&
              item.id === ref.id &&
              item.status !== "deprecated",
          )
        : undefined

      return summarizeContext({
        messages,
        limit: model?.limit.context,
        sessionCost: info?.cost ?? 0,
        revertMessageID: info?.revert?.messageID,
      })
    })
  })

  const projectName = createMemo(
    () =>
      props.session.listedProject?.name ??
      props.session.project?.name ??
      basename(directory()),
  )

  const branch = createMemo(() => {
    const location = props.session.location
    if (!location) return undefined
    return data().location.vcs.info(location)?.branch.current
  })

  const [changes, { refetch }] = createResource(
    () =>
      [
        props.session.server.id,
        directory(),
        props.session.server.connected,
      ] as const,
    async ([, dir]) => {
      try {
        const result = await props.session.server.client.vcs.status({
          location: { directory: dir },
        })
        return result.data
      } catch {
        return [] as VcsFileStatus[]
      }
    },
  )

  const files = createMemo(() => changes() ?? [])
  const totals = createMemo(() => sumChanges(files()))

  const syncSources = () => {
    const location = props.session.location
    if (!location) return

    const store = data()
    void Promise.allSettled([
      store.location.mcp.server.sync(location),
      store.location.websearch.refresh(location),
      store.location.reference.sync(location),
      store.location.integration.sync(location),
      store.location.model.sync(location),
    ])
  }

  createEffect(() => {
    props.session.location
    props.session.server.data
    syncSources()
  })

  createEffect(() => {
    const store = data()
    const sessionID = props.session.id
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void refetch()
      }, 250)
    }

    const offFiles = store.on("filesystem.changed", schedule)
    const offExec = store.on("session.execution.succeeded", (event) => {
      if (event.data.sessionID === sessionID) schedule()
    })

    onCleanup(() => {
      if (timer) clearTimeout(timer)
      offFiles()
      offExec()
    })
  })

  const subagents = createMemo(() => {
    const sessions = data().session.list()
    const ids = descendantIDs(sessions, props.session.id)

    return sessions
      .filter((session) => session.id !== props.session.id && ids.has(session.id))
      .sort((left, right) => right.time.created - left.time.created)
  })

  const done = createMemo(
    () => subagents().filter((session) => session.outcome !== undefined).length,
  )

  const running = createMemo(
    () =>
      subagents().filter((session) => data().session.status(session.id) === "running")
        .length,
  )

  const subagentSummary = createMemo(() => {
    if (subagents().length === 0) return "None"
    const parts = [`${done()} done`]
    if (running() > 0) parts.unshift(`${running()} running`)
    return parts.join(" · ")
  })

  const sources = createMemo<Source[]>(() => {
    const location = props.session.location
    if (!location) return []

    const store = data()
    const result: Source[] = []

    for (const server of store.location.mcp.server.list(location) ?? []) {
      if (server.status.status === "disabled") continue

      result.push({
        id: `mcp:${server.name}`,
        name: server.title ?? server.name,
        icon: "mcp",
        detail: mcpStatus(server.status.status),
        tone: mcpTone(server.status.status),
      })
    }

    const websearch = store.location.websearch.list(location) ?? []
    if (websearch.length > 0) {
      result.push({
        id: "websearch",
        name: "Web search",
        icon: "globe",
        detail: websearch.length === 1 ? websearch[0]?.name : `${websearch.length}`,
      })
    }

    for (const integration of store.location.integration.list(location) ?? []) {
      if (integration.connections.length === 0) continue

      result.push({
        id: `integration:${integration.id}`,
        name: integration.name,
        icon: "extensions",
        detail: "Connected",
        tone: "success",
      })
    }

    const references = (store.location.reference.list(location) ?? []).filter(
      (reference) => !reference.hidden,
    )
    if (references.length > 0) {
      result.push({
        id: "references",
        name: "References",
        icon: "link",
        detail: `${references.length}`,
      })
    }

    return result
  })

  const openSubagent = (session: SessionInfo) => {
    ctx.tabs.open({ server: props.session.server.id, id: session.id }, { focus: true })
  }

  const statusLabel = (session: SessionInfo) => {
    if (data().session.status(session.id) === "running") return "running"
    return session.outcome ?? "idle"
  }

  const openChanges = () => {
    const list = files()

    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title="Changes"
        description={
          list.length === 0 ? "No working-tree changes." : `${list.length} changed files`
        }
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            Close
          </ctx.ui.Button>
        }
      >
        <div class="flex flex-col gap-1">
          <For each={list}>
            {(file) => (
              <div class="flex items-center gap-2 py-1">
                <span class="flex-1 truncate" title={file.file}>
                  {file.file}
                </span>
                <span style={{ color: "var(--v2-state-fg-success)" }}>
                  +{file.additions}
                </span>
                <span style={{ color: "var(--v2-state-fg-danger)" }}>
                  -{file.deletions}
                </span>
              </div>
            )}
          </For>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openSubagents = () => {
    const list = subagents()

    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title="Subagents"
        description={`${list.length} sessions`}
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            Close
          </ctx.ui.Button>
        }
      >
        <div class="flex flex-col gap-1">
          <For each={list}>
            {(session) => (
              <button
                type="button"
                class="flex items-center gap-2 py-1 text-left"
                onClick={() => {
                  openSubagent(session)
                  dialog.close()
                }}
              >
                <Avatar session={session} />
                <span class="flex-1 truncate">
                  {session.title ?? session.agent ?? session.id}
                </span>
                <span
                  class="text-[11px]"
                  style={{ color: "var(--v2-text-text-faint)" }}
                >
                  {statusLabel(session)}
                </span>
              </button>
            )}
          </For>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openSources = () => {
    const list = sources()

    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title="Sources"
        description={
          list.length === 0 ? "No sources configured." : `${list.length} configured`
        }
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            Close
          </ctx.ui.Button>
        }
      >
        <div class="flex flex-col gap-1">
          <For each={list}>{(source) => <SourceRow source={source} />}</For>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openTiming = () => {
    const snapshot = timing()
    if (!snapshot) return

    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title="Timing"
        description={allTurns() ? "All turns" : "Session total"}
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            Close
          </ctx.ui.Button>
        }
      >
        <div class="flex flex-col gap-3">
          <ctx.ui.Switch
            label="Show all turns"
            description="List every turn separately."
            checked={allTurns()}
            onChange={setAllTurns}
          />
          <Show
            when={allTurns()}
            fallback={
              <div class="flex flex-col gap-1">
                <For each={timingRows(snapshot.summary)}>
                  {(row) => <TimingRowView row={row} />}
                </For>
              </div>
            }
          >
            <div class="flex flex-col gap-2">
              <For each={snapshot.turns}>
                {(turn, index) => (
                  <div
                    class="flex flex-col gap-0.5 border-t pt-2"
                    style={{ "border-color": "var(--v2-border-border-muted)" }}
                  >
                    <div class="flex items-center gap-2">
                      <span class="flex-1 text-[12px] font-[530]">
                        Turn {index() + 1}
                      </span>
                      <span class="text-[11px]">{formatRate(turn.rate)}</span>
                      <span
                        class="text-[11px]"
                        style={{ color: "var(--v2-text-text-faint)" }}
                      >
                        {formatShortDuration(turn.waitMs)} wait
                      </span>
                    </div>
                    <TimingLineView
                      summary={() => turn}
                      label={`Turn ${index() + 1}`}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openTerminal = () => {
    const desktop = ctx.desktop
    if (!desktop) return

    const app =
      desktop.os === "macos"
        ? "Terminal"
        : desktop.os === "windows"
          ? "wt"
          : "x-terminal-emulator"

    void desktop.launch(directory(), app).catch(() => {})
  }

  const menuItems: UiMenuEntry[] = [
    {
      label: "Copy session ID",
      icon: "copy",
      onSelect: () => {
        void ctx.system.copy(props.session.id).catch(() => {})
      },
    },
    {
      label: "Copy directory",
      icon: "folder",
      onSelect: () => {
        void ctx.system.copy(directory()).catch(() => {})
      },
    },
    {
      label: "Open terminal",
      icon: "terminal",
      disabled: !ctx.desktop,
      onSelect: openTerminal,
    },
    {
      label: "New session",
      icon: "new-session",
      onSelect: () => {
        ctx.layout.draft({
          server: props.session.server.id,
          directory: directory(),
          prompt: "",
        })
      },
    },
    { type: "separator" },
    {
      label: "Refresh",
      icon: "refresh",
      onSelect: () => {
        void refetch()
        syncSources()
      },
    },
    {
      label: "Settings",
      icon: "settings-gear",
      onSelect: () => ctx.layout.settings(),
    },
    { type: "separator" },
    {
      label: "Close panel",
      icon: "close",
      onSelect: () => ctx.layout.close(`${ctx.id}:overview`, props.session),
    },
  ]

  return (
    <div class="flex h-full flex-col gap-4 overflow-y-auto p-3 text-[13px]">
      <header class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-[14px] font-[530]">{projectName()}</div>
          <div
            class="truncate text-[11px]"
            style={{ color: "var(--v2-text-text-faint)" }}
          >
            {[branch(), basename(directory())].filter(Boolean).join(" · ")}
          </div>
        </div>
        <ctx.ui.Menu label={ctx.t("menu.actions")} items={menuItems} />
      </header>

      <Section
        title="Timing"
        indicator={
          <Show when={timing()}>
            <StatusDot tone={timingTone()} />
          </Show>
        }
        action={
          <Show when={timing()}>
            <button
              type="button"
              class="text-[11px]"
              style={{ color: "var(--v2-text-text-accent)" }}
              onClick={openTiming}
            >
              Details
            </button>
          </Show>
        }
      >
        <Show
          when={timing()}
          fallback={
            <span class="text-[12px]" style={{ color: "var(--v2-text-text-faint)" }}>
              No turns yet
            </span>
          }
        >
          {(snapshot) => {
            const summary = () => snapshot().summary

            return (
              <>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 py-1 text-left"
                  onClick={openTiming}
                >
                  <span style={{ color: "var(--v2-icon-icon-muted)" }}>
                    <ctx.ui.Icon name="waveform" size="small" />
                  </span>
                  <span class="flex-1">{formatRate(summary().rate)}</span>
                  <span
                    style={{
                      color: waitingOnYou()
                        ? "var(--v2-state-fg-warning)"
                        : "var(--v2-text-text-faint)",
                    }}
                  >
                    {formatShortDuration(summary().waitMs)} wait
                  </span>
                </button>
                <TimingBreakdown session={snapshot} />
                <div
                  class="text-[11px]"
                  style={{ color: "var(--v2-text-text-faint)" }}
                >
                  {summary().running ? "Running" : "Session"} ·{" "}
                  {formatTokens(summary().tokens)} tokens
                </div>
              </>
            )
          }}
        </Show>
      </Section>

      <Section
        title="Context"
        action={
          <Show when={context()}>
            {(snapshot) => (
              <span
                class="text-[11px]"
                style={{ color: "var(--v2-text-text-faint)" }}
              >
                {snapshot().limit
                  ? `${formatTokens(snapshot().total)} / ${formatTokens(snapshot().limit!)}`
                  : formatTokens(snapshot().total)}
              </span>
            )}
          </Show>
        }
      >
        <Show
          when={context()}
          fallback={
            <span class="text-[12px]" style={{ color: "var(--v2-text-text-faint)" }}>
              No usage yet
            </span>
          }
        >
          {(snapshot) => {
            const denominator = () => {
              const item = snapshot()
              return Math.max(item.limit ?? item.total, item.total, 1)
            }
            const width = (value: number) =>
              `${Math.max(0, Math.min(100, (value / denominator()) * 100))}%`
            const segments = () => {
              const composition = snapshot().composition
              const result = [
                {
                  id: "system",
                  label: "System",
                  value: composition.system,
                  color: "var(--v2-text-text-faint)",
                },
                {
                  id: "tools",
                  label: "Tools/overhead",
                  value: composition.overhead,
                  color: "var(--v2-state-fg-warning)",
                },
                {
                  id: "chat",
                  label: "Chat",
                  value: composition.conversation,
                  color: "var(--v2-state-fg-success)",
                },
                {
                  id: "results",
                  label: "Results",
                  value: composition.results,
                  color: "var(--v2-text-text-accent)",
                },
              ]

              if (composition.summary > 0) {
                result.push({
                  id: "summary",
                  label: "Summary",
                  value: composition.summary,
                  color: "var(--v2-text-text-muted)",
                })
              }

              return result
            }
            const jump = () => {
              const item = snapshot()
              if (item.turnGrowth === undefined) return

              const parts = [
                `${item.turnGrowth >= 0 ? "+" : "-"}${formatTokens(Math.abs(item.turnGrowth))} this turn`,
              ]
              if (item.turnResultTokens > 0) {
                parts.push(`${formatTokens(item.turnResultTokens)} results`)
              }
              if (item.turnCost > 0) parts.push(formatCost(item.turnCost))
              return parts.join(" · ")
            }
            const consumerText = (consumer: {
              readonly label: string
              readonly detail?: string
            }) =>
              consumer.detail
                ? `${consumer.label} · ${consumer.detail}`
                : consumer.label
            const top = () => snapshot().consumers.slice(0, 3)
            const topTitle = () =>
              snapshot()
                .consumers.map(
                  (consumer) =>
                    `${consumerText(consumer)} ${formatTokens(consumer.tokens)}`,
                )
                .join(" · ")

            return (
              <div class="flex flex-col gap-1.5">
                <div
                  class="flex h-[6px] w-full overflow-hidden rounded-full"
                  style={{ background: "var(--v2-background-bg-layer-04)" }}
                >
                  <For each={segments()}>
                    {(segment) => (
                      <div
                        style={{
                          width: width(segment.value),
                          height: "100%",
                          background: segment.color,
                          "flex-shrink": 0,
                        }}
                      />
                    )}
                  </For>
                </div>
                <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  <For each={segments()}>
                    {(segment) => (
                      <ContextLegend
                        label={segment.label}
                        value={segment.value}
                        color={segment.color}
                      />
                    )}
                  </For>
                </div>
                <Show when={jump()}>
                  <div
                    class="truncate text-[11px]"
                    style={{ color: "var(--v2-text-text-faint)" }}
                    title={jump()}
                  >
                    {jump()}
                  </div>
                </Show>
                <Show when={snapshot().consumers.length > 0}>
                  <div
                    class="truncate text-[11px]"
                    style={{ color: "var(--v2-text-text-faint)" }}
                    title={topTitle()}
                  >
                    <span>Top</span>{" "}
                    <For each={top()}>
                      {(consumer, index) => (
                        <>
                          <Show when={index() > 0}> · </Show>
                          <span style={{ color: "var(--v2-text-text-muted)" }}>
                            {consumerText(consumer)}
                          </span>{" "}
                          <span style={{ color: "var(--v2-text-text-muted)" }}>
                            {formatTokens(consumer.tokens)}
                          </span>
                        </>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )
          }}
        </Show>
      </Section>

      <Section title="Changes">
        <button
          type="button"
          class="flex w-full items-center gap-2 py-1 text-left"
          onClick={openChanges}
        >
          <span style={{ color: "var(--v2-icon-icon-muted)" }}>
            <ctx.ui.Icon name="branch" size="small" />
          </span>
          <span class="flex-1">Changes</span>
          <Show when={!changes.loading} fallback={<ctx.ui.Loader size="small" />}>
            <span style={{ color: "var(--v2-state-fg-success)" }}>
              +{totals().additions}
            </span>
            <span style={{ color: "var(--v2-state-fg-danger)" }}>
              -{totals().deletions}
            </span>
          </Show>
        </button>
        <div class="text-[11px]" style={{ color: "var(--v2-text-text-faint)" }}>
          {totals().files === 0
            ? "No working-tree changes"
            : `${totals().files} changed file${totals().files === 1 ? "" : "s"}`}
        </div>
      </Section>

      <Section
        title="Subagents"
        action={
          <Show when={subagents().length > 0}>
            <button
              type="button"
              class="text-[11px]"
              style={{ color: "var(--v2-text-text-accent)" }}
              onClick={openSubagents}
            >
              View all
            </button>
          </Show>
        }
      >
        <div class="flex items-center gap-2">
          <Show
            when={subagents().length > 0}
            fallback={
              <span class="text-[12px]" style={{ color: "var(--v2-text-text-faint)" }}>
                None
              </span>
            }
          >
            <div class="flex items-center gap-1">
              <For each={subagents().slice(0, 5)}>
                {(session) => (
                  <button
                    type="button"
                    class="flex items-center"
                    title={session.title ?? session.agent ?? session.id}
                    onClick={() => openSubagent(session)}
                  >
                    <Avatar session={session} />
                  </button>
                )}
              </For>
            </div>
            <span class="text-[12px]" style={{ color: "var(--v2-text-text-muted)" }}>
              {subagentSummary()}
            </span>
          </Show>
        </div>
      </Section>

      <Section
        title="Sources"
        action={
          <ctx.ui.IconButton
            icon="plus"
            label="Add source"
            size="small"
            onClick={() => ctx.layout.settings()}
          />
        }
      >
        <Show
          when={sources().length > 0}
          fallback={
            <span class="text-[12px]" style={{ color: "var(--v2-text-text-faint)" }}>
              No sources configured
            </span>
          }
        >
          <div class="flex flex-col gap-0.5">
            <For each={sources().slice(0, 3)}>
              {(source) => <SourceRow source={source} />}
            </For>
          </div>
          <Show when={sources().length > 0}>
            <button
              type="button"
              class="flex items-center gap-2 py-1 text-left text-[12px]"
              style={{ color: "var(--v2-text-text-accent)" }}
              onClick={openSources}
            >
              <ctx.ui.Icon name="link" size="small" />
              View all
            </button>
          </Show>
        </Show>
      </Section>
    </div>
  )
}

function Section(props: {
  readonly title: string
  readonly indicator?: JSX.Element
  readonly action?: JSX.Element
  readonly children?: JSX.Element
}) {
  return (
    <section
      class="flex flex-col gap-1.5 border-t pt-3"
      style={{ "border-color": "var(--v2-border-border-muted)" }}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5">
          {props.indicator}
          <span
            class="text-[12px] font-[530]"
            style={{ color: "var(--v2-text-text-muted)" }}
          >
            {props.title}
          </span>
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

function StatusDot(props: { readonly tone: "success" | "warning" }) {
  const label = () =>
    props.tone === "success" ? "Running" : "Waiting for input"

  return (
    <span
      role="img"
      aria-label={label()}
      title={label()}
      style={{
        width: "6px",
        height: "6px",
        "border-radius": "9999px",
        background:
          props.tone === "success"
            ? "var(--v2-state-fg-success)"
            : "var(--v2-state-fg-warning)",
        "flex-shrink": 0,
      }}
    />
  )
}

function TimingBreakdown(props: { readonly session: () => SessionSummary }) {
  const current = () => {
    const session = props.session()
    return session.turns[session.turns.length - 1] ?? session.summary
  }
  const total = () => props.session().summary

  return (
    <div
      class="grid text-[11px]"
      style={{
        "grid-template-columns": "max-content max-content max-content max-content",
        "column-gap": "10px",
        "row-gap": "1px",
        "line-height": "1.2",
        "font-variant-numeric": "tabular-nums",
      }}
      title="Current run above cumulative"
    >
      <TimingCell label="Model" value={formatDuration(current().modelMs)} />
      <TimingCell label="Shell" value={formatDuration(current().shellMs)} />
      <TimingCell label="Tools" value={formatDuration(current().pluginMs)} />
      <TimingCell label="Other" value={formatDuration(current().otherMs)} />

      <TimingCell label="Model" value={formatDuration(total().modelMs)} dim />
      <TimingCell label="Shell" value={formatDuration(total().shellMs)} dim />
      <TimingCell label="Tools" value={formatDuration(total().pluginMs)} dim />
      <TimingCell label="Other" value={formatDuration(total().otherMs)} dim />
    </div>
  )
}

function TimingLineView(props: {
  readonly summary: () => TurnSummary
  readonly label?: string
  readonly dim?: boolean
}) {
  const text = () => {
    const summary = props.summary()
    return [
      `Model ${formatDuration(summary.modelMs)}`,
      `Shell ${formatDuration(summary.shellMs)}`,
      `Tools ${formatDuration(summary.pluginMs)}`,
      `Other ${formatDuration(summary.otherMs)}`,
    ].join(" · ")
  }

  return (
    <div
      class="text-[11px]"
      style={{
        "white-space": "nowrap",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        "line-height": "1.2",
        "font-variant-numeric": "tabular-nums",
        opacity: props.dim ? 0.65 : 1,
      }}
      title={`${props.label ? `${props.label}: ` : ""}${text()}`}
    >
      <TimingCell label="Model" value={formatDuration(props.summary().modelMs)} />
      <TimingDivider />
      <TimingCell label="Shell" value={formatDuration(props.summary().shellMs)} />
      <TimingDivider />
      <TimingCell label="Tools" value={formatDuration(props.summary().pluginMs)} />
      <TimingDivider />
      <TimingCell label="Other" value={formatDuration(props.summary().otherMs)} />
    </div>
  )
}

function TimingDivider() {
  return <span style={{ color: "var(--v2-text-text-faint)" }}> · </span>
}

function TimingRowView(props: { readonly row: TimingRow }) {
  return (
    <div class="flex items-center gap-2 py-1">
      <span class="flex-1">{props.row.label}</span>
      <span
        style={{
          color:
            props.row.tone === "warning"
              ? "var(--v2-state-fg-warning)"
              : undefined,
        }}
      >
        {props.row.detail}
      </span>
    </div>
  )
}

function ContextLegend(props: {
  readonly label: string
  readonly value: number
  readonly color: string
}) {
  return (
    <span
      class="flex min-w-0 items-center gap-1.5"
      style={{ color: "var(--v2-text-text-faint)" }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          "border-radius": "9999px",
          background: props.color,
          "flex-shrink": 0,
        }}
      />
      <span class="truncate">{props.label}</span>
      <span class="ml-auto" style={{ color: "var(--v2-text-text-muted)" }}>
        {formatTokens(props.value)}
      </span>
    </span>
  )
}

function TimingCell(props: {
  readonly label: string
  readonly value: string
  readonly dim?: boolean
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        "align-items": "baseline",
        "justify-content": "space-between",
        "column-gap": "4px",
        "white-space": "nowrap",
        opacity: props.dim ? 0.65 : 1,
      }}
    >
      <span style={{ color: "var(--v2-text-text-faint)" }}>{props.label}</span>
      <span style={{ color: "var(--v2-text-text-muted)" }}>{props.value}</span>
    </span>
  )
}

function SourceRow(props: { readonly source: Source }) {
  const ctx = usePlugin()

  return (
    <div class="flex items-center gap-2 py-0.5">
      <span style={{ color: sourceColor(props.source.tone) }}>
        <ctx.ui.Icon name={props.source.icon} size="small" />
      </span>
      <span class="flex-1 truncate">{props.source.name}</span>
      <Show when={props.source.detail}>
        <span
          class="text-[11px]"
          style={{ color: "var(--v2-text-text-faint)" }}
        >
          {props.source.detail}
        </span>
      </Show>
    </div>
  )
}

function Avatar(props: { readonly session: SessionInfo }) {
  return (
    <span
      class="flex items-center justify-center rounded-full text-[10px] font-[530]"
      style={{
        width: "20px",
        height: "20px",
        background: avatarColor(props.session.id),
        color: "#fff",
      }}
    >
      {initials(props.session.agent ?? props.session.title ?? props.session.id)}
    </span>
  )
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  return value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`
}

function sourceColor(tone: SourceTone | undefined): string {
  if (tone === "success") return "var(--v2-state-fg-success)"
  if (tone === "warning") return "var(--v2-state-fg-warning)"
  if (tone === "danger") return "var(--v2-state-fg-danger)"
  return "var(--v2-icon-icon-muted)"
}

function mcpStatus(status: string): string {
  if (status === "connected") return "Connected"
  if (status === "pending") return "Starting"
  if (status === "needs_auth") return "Needs auth"
  if (status === "failed") return "Failed"
  return status
}

function mcpTone(status: string): SourceTone | undefined {
  if (status === "connected") return "success"
  if (status === "pending") return "warning"
  if (status === "needs_auth" || status === "failed") return "danger"
  return undefined
}
