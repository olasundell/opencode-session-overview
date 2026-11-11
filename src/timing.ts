import type { SessionMessageInfo } from "@opencode/client"
import {
  calibrateRatio,
  modelKey,
  ratioFor,
  summarizeSession,
  type Interval,
  type ModelRef,
  type SessionSummary,
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

type SessionState = {
  executionStart?: number
  live?: LiveStep
  retryOpen?: OpenWait
  human: Interval[]
  retry: Interval[]
  permissionOpen: Map<string, OpenWait>
  formOpen: Map<string, OpenWait>
  touchedAt: number
}

export type TimingRegistry = {
  attach(on: TimingSubscribe): () => void
  snapshot(
    sessionID: string,
    messages: readonly SessionMessageInfo[],
    now: number,
    running: boolean,
  ): SessionSummary | undefined
  prune(now: number): void
}

const KEEP_MS = 2 * 60 * 60 * 1000

function createState(at: number): SessionState {
  return {
    human: [],
    retry: [],
    permissionOpen: new Map(),
    formOpen: new Map(),
    touchedAt: at,
  }
}

/**
 * Observe every session on one server. The persisted message store supplies
 * steps, tokens and tool times; live events supply streaming deltas,
 * permission/form waits and provider retry waits. State is keyed by session and
 * survives panel mounts, so closing the Overview does not reset live waits.
 */
export function createTimingRegistry(input?: {
  readonly charsPerToken?: number
}): TimingRegistry {
  const fallbackRatio = input?.charsPerToken ?? 4
  const sessions = new Map<string, SessionState>()
  const ratios = new Map<string, number>()

  const stateFor = (id: string, at: number) => {
    let state = sessions.get(id)
    if (!state) {
      state = createState(at)
      sessions.set(id, state)
    }
    state.touchedAt = at
    return state
  }

  const eventState = (event: TimingEvent, form = false) => {
    const id = form ? event.data?.form?.sessionID : event.data?.sessionID
    if (!id) return undefined
    return stateFor(id, event.created ?? Date.now())
  }

  const closeRetry = (state: SessionState, at: number) => {
    if (!state.retryOpen) return
    state.retry.push({ start: state.retryOpen.start, end: at })
    state.retryOpen = undefined
  }

  const addDelta = (state: SessionState, event: TimingEvent) => {
    const delta = event.data?.delta
    if (!delta) return

    const at = event.created ?? Date.now()
    if (!state.live) state.live = { chars: 0, firstDeltaAt: at, fresh: false }
    if (state.live.firstDeltaAt === undefined) state.live.firstDeltaAt = at
    state.live.chars += delta.length
    state.touchedAt = at
  }

  const finishStep = (state: SessionState, event: TimingEvent) => {
    if (state.live?.fresh) {
      const tokens =
        (event.data?.tokens?.output ?? 0) + (event.data?.tokens?.reasoning ?? 0)
      const key = modelKey(state.live.model)
      const next = calibrateRatio(ratios.get(key), state.live.chars, tokens)

      if (next !== undefined) {
        ratios.set(key, next)

        if (key !== "*") {
          const fallback = calibrateRatio(ratios.get("*"), state.live.chars, tokens)
          if (fallback !== undefined) ratios.set("*", fallback)
        }
      }
    }

    state.live = undefined
    state.touchedAt = event.created ?? Date.now()
  }

  const attach = (on: TimingSubscribe) => {
    const cleanups = [
      on("session.execution.started", (event) => {
        const state = eventState(event)
        if (!state) return
        state.executionStart = event.created ?? Date.now()
        state.live = undefined
      }),
      on("session.execution.succeeded", (event) => {
        const state = eventState(event)
        if (!state) return
        closeRetry(state, event.created ?? Date.now())
        state.executionStart = undefined
        state.live = undefined
      }),
      on("session.execution.failed", (event) => {
        const state = eventState(event)
        if (!state) return
        closeRetry(state, event.created ?? Date.now())
        state.executionStart = undefined
        state.live = undefined
      }),
      on("session.execution.interrupted", (event) => {
        const state = eventState(event)
        if (!state) return
        closeRetry(state, event.created ?? Date.now())
        state.executionStart = undefined
        state.live = undefined
      }),
      on("session.step.started", (event) => {
        const state = eventState(event)
        if (!state) return
        closeRetry(state, event.created ?? Date.now())
        state.live = { chars: 0, model: event.data?.model, fresh: true }
      }),
      on("session.text.delta", (event) => {
        const state = eventState(event)
        if (state) addDelta(state, event)
      }),
      on("session.reasoning.delta", (event) => {
        const state = eventState(event)
        if (state) addDelta(state, event)
      }),
      on("session.tool.input.delta", (event) => {
        const state = eventState(event)
        if (state) addDelta(state, event)
      }),
      on("session.step.ended", (event) => {
        const state = eventState(event)
        if (state) finishStep(state, event)
      }),
      on("session.step.failed", (event) => {
        const state = eventState(event)
        if (!state) return
        state.live = undefined
      }),
      on("session.retry.scheduled", (event) => {
        const state = eventState(event)
        if (!state || state.retryOpen) return
        state.retryOpen = {
          id: "retry",
          start: event.created ?? Date.now(),
        }
      }),
      on("permission.asked", (event) => {
        const state = eventState(event)
        const id = event.data?.id
        if (!state || !id) return
        state.permissionOpen.set(id, {
          id,
          start: event.created ?? Date.now(),
        })
      }),
      on("permission.replied", (event) => {
        const state = eventState(event)
        const id = event.data?.requestID
        if (!state || !id) return

        const open = state.permissionOpen.get(id)
        if (!open) return

        state.permissionOpen.delete(id)
        state.human.push({ start: open.start, end: event.created ?? Date.now() })
      }),
      on("form.created", (event) => {
        const state = eventState(event, true)
        const id = event.data?.form?.id
        if (!state || !id) return
        state.formOpen.set(id, {
          id,
          start: event.created ?? Date.now(),
        })
      }),
      on("form.replied", (event) => {
        const state = eventState(event)
        const id = event.data?.id
        if (!state || !id) return

        const open = state.formOpen.get(id)
        if (!open) return

        state.formOpen.delete(id)
        state.human.push({ start: open.start, end: event.created ?? Date.now() })
      }),
      on("form.cancelled", (event) => {
        const state = eventState(event)
        const id = event.data?.id
        if (!state || !id) return

        const open = state.formOpen.get(id)
        if (!open) return

        state.formOpen.delete(id)
        state.human.push({ start: open.start, end: event.created ?? Date.now() })
      }),
    ]

    return () => cleanups.forEach((cleanup) => cleanup())
  }

  const snapshot = (
    sessionID: string,
    messages: readonly SessionMessageInfo[],
    now: number,
    running: boolean,
  ): SessionSummary | undefined => {
    const state = sessions.get(sessionID)
    const humanOpen: Interval[] = []

    if (state) {
      for (const open of state.permissionOpen.values()) {
        humanOpen.push({ start: open.start, end: now })
      }
      for (const open of state.formOpen.values()) {
        humanOpen.push({ start: open.start, end: now })
      }
      state.touchedAt = now
    }

    const retry = state ? state.retry.slice() : []
    if (state?.retryOpen) retry.push({ start: state.retryOpen.start, end: now })

    return summarizeSession({
      messages,
      now,
      running,
      executionStart: state?.executionStart,
      human: state?.human ?? [],
      humanOpen,
      retry,
      live:
        state?.live?.fresh && state.live.chars > 0
          ? {
              chars: state.live.chars,
              charsPerToken: ratioFor(
                ratios,
                state.live.model,
                fallbackRatio,
              ),
              streamedAt: state.live.firstDeltaAt,
            }
          : undefined,
    })
  }

  const prune = (now: number) => {
    const cutoff = now - KEEP_MS

    for (const [id, state] of sessions) {
      state.human = state.human.filter((interval) => interval.end > cutoff)
      state.retry = state.retry.filter((interval) => interval.end > cutoff)

      const idle =
        state.touchedAt < cutoff &&
        state.executionStart === undefined &&
        state.live === undefined &&
        state.retryOpen === undefined &&
        state.permissionOpen.size === 0 &&
        state.formOpen.size === 0

      if (idle) sessions.delete(id)
    }
  }

  return { attach, snapshot, prune }
}
