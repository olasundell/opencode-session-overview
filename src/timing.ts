import type { SessionMessageInfo } from "@opencode/client"
import {
  calibrateRatio,
  modelKey,
  ratioFor,
  summarizeTurn,
  type Interval,
  type ModelRef,
  type TurnSummary,
} from "./turn.ts"

export type TimingEvent = {
  readonly created?: number
  readonly data?: {
    readonly sessionID?: string
    readonly id?: string
    readonly requestID?: string
    readonly form?: {
      readonly id?: string
      readonly sessionID?: string
    }
    readonly model?: ModelRef
    readonly delta?: string
    readonly tokens?: {
      readonly output?: number
      readonly reasoning?: number
    }
  }
}

export type TimingSubscribe = (
  type: string,
  handler: (event: TimingEvent) => void,
) => () => void

type OpenWait = {
  readonly id: string
  readonly start: number
}

type LiveStep = {
  chars: number
  readonly model?: ModelRef
  firstDeltaAt?: number
  readonly fresh: boolean
}

export type TimingTracker = {
  attach(on: TimingSubscribe): () => void
  summary(
    messages: readonly SessionMessageInfo[],
    now: number,
    running: boolean,
  ): TurnSummary | undefined
}

/**
 * Observe one session and summarize its current or last turn. The persisted
 * message store supplies steps, tokens and tool times; live events supply
 * streaming deltas, permission/form waits and provider retry waits.
 */
export function createTimingTracker(input: {
  readonly sessionID: string
  readonly onChange: () => void
  readonly charsPerToken?: number
}): TimingTracker {
  const fallbackRatio = input.charsPerToken ?? 4

  let executionStart: number | undefined
  let live: LiveStep | undefined
  let retryOpen: OpenWait | undefined

  const ratios = new Map<string, number>()
  const human: Interval[] = []
  const retry: Interval[] = []
  const permissionOpen = new Map<string, OpenWait>()
  const formOpen = new Map<string, OpenWait>()

  const changed = () => input.onChange()

  const closeRetry = (at: number) => {
    if (!retryOpen) return
    retry.push({ start: retryOpen.start, end: at })
    retryOpen = undefined
  }

  const addDelta = (event: TimingEvent) => {
    const delta = event.data?.delta
    if (!delta) return

    const at = event.created ?? Date.now()
    if (!live) live = { chars: 0, firstDeltaAt: at, fresh: false }
    if (live.firstDeltaAt === undefined) live.firstDeltaAt = at
    live.chars += delta.length
  }

  const finishStep = (event: TimingEvent) => {
    if (live?.fresh) {
      const tokens =
        (event.data?.tokens?.output ?? 0) + (event.data?.tokens?.reasoning ?? 0)
      const key = modelKey(live.model)
      const next = calibrateRatio(ratios.get(key), live.chars, tokens)

      if (next !== undefined) {
        ratios.set(key, next)

        if (key !== "*") {
          const fallback = calibrateRatio(ratios.get("*"), live.chars, tokens)
          if (fallback !== undefined) ratios.set("*", fallback)
        }
      }
    }

    live = undefined
    changed()
  }

  const attach = (on: TimingSubscribe) => {
    const current = (sessionID: string | undefined) => sessionID === input.sessionID

    const cleanups = [
      on("session.execution.started", (event) => {
        if (!current(event.data?.sessionID)) return
        executionStart = event.created ?? Date.now()
        live = undefined
        changed()
      }),
      on("session.execution.succeeded", (event) => {
        if (!current(event.data?.sessionID)) return
        closeRetry(event.created ?? Date.now())
        executionStart = undefined
        live = undefined
        changed()
      }),
      on("session.execution.failed", (event) => {
        if (!current(event.data?.sessionID)) return
        closeRetry(event.created ?? Date.now())
        executionStart = undefined
        live = undefined
        changed()
      }),
      on("session.execution.interrupted", (event) => {
        if (!current(event.data?.sessionID)) return
        closeRetry(event.created ?? Date.now())
        executionStart = undefined
        live = undefined
        changed()
      }),
      on("session.step.started", (event) => {
        if (!current(event.data?.sessionID)) return
        closeRetry(event.created ?? Date.now())
        live = { chars: 0, model: event.data?.model, fresh: true }
        changed()
      }),
      on("session.text.delta", (event) => {
        if (current(event.data?.sessionID)) addDelta(event)
      }),
      on("session.reasoning.delta", (event) => {
        if (current(event.data?.sessionID)) addDelta(event)
      }),
      on("session.tool.input.delta", (event) => {
        if (current(event.data?.sessionID)) addDelta(event)
      }),
      on("session.step.ended", (event) => {
        if (current(event.data?.sessionID)) finishStep(event)
      }),
      on("session.step.failed", (event) => {
        if (!current(event.data?.sessionID)) return
        live = undefined
        changed()
      }),
      on("session.retry.scheduled", (event) => {
        if (!current(event.data?.sessionID) || retryOpen) return
        retryOpen = { id: "retry", start: event.created ?? Date.now() }
        changed()
      }),
      on("permission.asked", (event) => {
        const id = event.data?.id
        if (!id || !current(event.data?.sessionID)) return
        permissionOpen.set(id, { id, start: event.created ?? Date.now() })
        changed()
      }),
      on("permission.replied", (event) => {
        const id = event.data?.requestID
        if (!id || !current(event.data?.sessionID)) return

        const open = permissionOpen.get(id)
        if (!open) return

        permissionOpen.delete(id)
        human.push({ start: open.start, end: event.created ?? Date.now() })
        changed()
      }),
      on("form.created", (event) => {
        const form = event.data?.form
        const id = form?.id
        if (!id || !current(form?.sessionID)) return
        formOpen.set(id, { id, start: event.created ?? Date.now() })
        changed()
      }),
      on("form.replied", (event) => {
        const id = event.data?.id
        if (!id || !current(event.data?.sessionID)) return

        const open = formOpen.get(id)
        if (!open) return

        formOpen.delete(id)
        human.push({ start: open.start, end: event.created ?? Date.now() })
        changed()
      }),
      on("form.cancelled", (event) => {
        const id = event.data?.id
        if (!id || !current(event.data?.sessionID)) return

        const open = formOpen.get(id)
        if (!open) return

        formOpen.delete(id)
        human.push({ start: open.start, end: event.created ?? Date.now() })
        changed()
      }),
    ]

    return () => cleanups.forEach((cleanup) => cleanup())
  }

  const summary = (
    messages: readonly SessionMessageInfo[],
    now: number,
    running: boolean,
  ): TurnSummary | undefined => {
    const humanOpen: Interval[] = []
    for (const open of permissionOpen.values()) {
      humanOpen.push({ start: open.start, end: now })
    }
    for (const open of formOpen.values()) {
      humanOpen.push({ start: open.start, end: now })
    }

    const retryIntervals = retry.slice()
    if (retryOpen) retryIntervals.push({ start: retryOpen.start, end: now })

    return summarizeTurn({
      messages,
      now,
      running,
      executionStart,
      human,
      humanOpen,
      retry: retryIntervals,
      live:
        live?.fresh && live.chars > 0
          ? {
              chars: live.chars,
              charsPerToken: ratioFor(ratios, live.model, fallbackRatio),
              streamedAt: live.firstDeltaAt,
            }
          : undefined,
    })
  }

  return { attach, summary }
}
