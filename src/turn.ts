import type { SessionMessageInfo } from "@opencode/client"

export type Interval = {
  readonly start: number
  readonly end: number
}

export type ToolUsage = {
  readonly name: string
  readonly count: number
  readonly ms: number
}

export type ModelRef = {
  readonly providerID?: string
  readonly id?: string
  readonly modelID?: string
}

export type LiveEstimate = {
  /** Characters streamed for the current step. */
  readonly chars: number
  /** Characters per token, calibrated from completed steps. */
  readonly charsPerToken: number
  /** First streamed delta for the current step, when it differs from the stored time. */
  readonly streamedAt?: number
}

export type TurnInput = {
  readonly messages: readonly SessionMessageInfo[]
  readonly now: number
  readonly running: boolean
  /** Server timestamp of the current execution, when the plugin saw it start. */
  readonly executionStart?: number
  /** Closed permission/form waits. */
  readonly human: readonly Interval[]
  /** Open permission/form waits, with `end` set to now. */
  readonly humanOpen: readonly Interval[]
  /** Closed or open provider retry waits. */
  readonly retry: readonly Interval[]
  /** Live estimate for the current step. */
  readonly live?: LiveEstimate
}

export type TurnSummary = {
  readonly running: boolean
  readonly startedAt: number
  readonly endedAt: number
  readonly totalMs: number
  readonly modelMs: number
  readonly waitMs: number
  readonly toolMs: number
  readonly shellMs: number
  readonly pluginMs: number
  readonly humanMs: number
  readonly retryMs: number
  readonly otherMs: number
  readonly tokens: number
  readonly rate?: number
  readonly toolCount: number
  readonly shellCount: number
  readonly pluginCount: number
  readonly tools: readonly ToolUsage[]
  readonly humanCount: number
  readonly pendingHumanMs: number
  readonly longestToolMs: number
}

export type SessionSummary = {
  readonly summary: TurnSummary
  readonly turns: readonly TurnSummary[]
}

type TurnSlice = {
  readonly messages: readonly SessionMessageInfo[]
  readonly executionStart?: number
  readonly running: boolean
  readonly windowStart: number
  readonly windowEnd: number
}

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>
type ToolPart = Extract<AssistantMessage["content"][number], { type: "tool" }>

const MIN_MODEL_MS = 250
const MIN_CHARS_PER_TOKEN = 1.5
const MAX_CHARS_PER_TOKEN = 16

const SHELL_TOOLS = new Set(["shell", "bash", "sh", "zsh", "terminal"])

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase())
}

function isAssistant(message: SessionMessageInfo): message is AssistantMessage {
  return message.type === "assistant"
}

function messageCreated(message: SessionMessageInfo): number | undefined {
  const time = (message as { time?: { created?: unknown } }).time
  return typeof time?.created === "number" ? time.created : undefined
}

function firstToolRan(assistant: AssistantMessage): number | undefined {
  let first: number | undefined

  for (const part of assistant.content) {
    if (part.type !== "tool") continue

    const ran = part.time.ran
    if (ran !== undefined && (first === undefined || ran < first)) first = ran
  }

  return first
}

function selectTurn(
  messages: readonly SessionMessageInfo[],
  executionStart: number | undefined,
): { assistants: AssistantMessage[]; startedAt: number } | undefined {
  // The API can return messages newest-first, so normalize before selecting
  // the trailing turn.
  const ordered = messages
    .slice()
    .sort((left, right) => (messageCreated(left) ?? 0) - (messageCreated(right) ?? 0))

  let startIndex = -1

  if (executionStart !== undefined) {
    for (let index = 0; index < ordered.length; index++) {
      const at = messageCreated(ordered[index])
      if (at !== undefined && at >= executionStart) {
        startIndex = index
        break
      }
    }
  }

  if (startIndex < 0) {
    for (let index = ordered.length - 1; index >= 0; index--) {
      if (ordered[index].type === "user") {
        startIndex = index
        break
      }
    }
  }

  if (startIndex < 0) {
    for (let index = ordered.length - 1; index >= 0; index--) {
      if (ordered[index].type !== "assistant") continue

      startIndex = index
      while (startIndex > 0 && ordered[startIndex - 1].type === "assistant") startIndex--
      break
    }
  }

  if (startIndex < 0) return undefined

  const selected = ordered.slice(startIndex)
  const assistants = selected.filter(isAssistant)
  if (assistants.length === 0) return undefined

  const firstAt =
    messageCreated(selected[0]) ?? executionStart ?? assistants[0].time.created ?? 0

  return {
    assistants,
    startedAt: executionStart ?? firstAt,
  }
}

/**
 * Merge overlapping intervals. Invalid and empty intervals are dropped.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.start) &&
        Number.isFinite(interval.end) &&
        interval.end > interval.start,
    )
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const merged: Interval[] = []

  for (const interval of sorted) {
    const last = merged[merged.length - 1]

    if (last && interval.start <= last.end) {
      if (interval.end > last.end) merged[merged.length - 1] = { start: last.start, end: interval.end }
      continue
    }

    merged.push({ start: interval.start, end: interval.end })
  }

  return merged
}

export function unionMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, interval) => sum + (interval.end - interval.start), 0)
}

export function overlapMs(left: readonly Interval[], right: readonly Interval[]): number {
  return Math.max(0, unionMs(left) + unionMs(right) - unionMs([...left, ...right]))
}

export function clipIntervals(
  intervals: readonly Interval[],
  start: number,
  end: number,
): Interval[] {
  if (end <= start) return []

  const clipped: Interval[] = []

  for (const interval of intervals) {
    const clippedStart = Math.max(start, interval.start)
    const clippedEnd = Math.min(end, interval.end)
    if (clippedEnd > clippedStart) clipped.push({ start: clippedStart, end: clippedEnd })
  }

  return clipped
}

export function calibrateRatio(
  previous: number | undefined,
  chars: number,
  tokens: number,
): number | undefined {
  if (!Number.isFinite(chars) || !Number.isFinite(tokens) || chars <= 0 || tokens <= 0) {
    return previous
  }

  const observed = chars / tokens
  if (
    !Number.isFinite(observed) ||
    observed < MIN_CHARS_PER_TOKEN ||
    observed > MAX_CHARS_PER_TOKEN
  ) {
    return previous
  }

  if (previous === undefined || !Number.isFinite(previous)) return observed
  return previous * 0.7 + observed * 0.3
}

export function modelKey(model: ModelRef | undefined): string {
  if (!model) return "*"

  const id = model.id ?? model.modelID
  if (!id) return "*"

  return model.providerID ? `${model.providerID}/${id}` : id
}

export function ratioFor(
  ratios: ReadonlyMap<string, number>,
  model: ModelRef | undefined,
  fallback = 4,
): number {
  return ratios.get(modelKey(model)) ?? ratios.get("*") ?? fallback
}

/**
 * Summarize the current or last turn. The turn starts at the execution start
 * when known, else at the last user prompt. Wait time is wall-clock time in the
 * turn that was not spent generating tokens.
 */
export function summarizeTurn(input: TurnInput): TurnSummary | undefined {
  const selected = selectTurn(input.messages, input.executionStart)
  if (!selected) return undefined

  const { assistants, startedAt } = selected
  const toolIntervalsByName = new Map<string, Interval[]>()
  const questionIntervals: Interval[] = []
  const questionOpen: Interval[] = []

  for (const assistant of assistants) {
    for (const part of assistant.content) {
      if (part.type !== "tool") continue

      const ran = part.time.ran
      if (ran === undefined) continue

      const completed = part.time.completed
      const open = completed === undefined && part.state.status === "running"
      const end = completed ?? (open ? input.now : undefined)
      if (end === undefined || end <= ran) continue

      const interval = { start: ran, end }

      if (part.name === "question") {
        questionIntervals.push(interval)
        if (open) questionOpen.push(interval)
        continue
      }

      const list = toolIntervalsByName.get(part.name)
      if (list) list.push(interval)
      else toolIntervalsByName.set(part.name, [interval])
    }
  }

  let lastActivity = startedAt

  for (const assistant of assistants) {
    lastActivity = Math.max(
      lastActivity,
      assistant.time.completed ?? assistant.time.streamed ?? assistant.time.created,
    )
  }

  for (const interval of questionIntervals) lastActivity = Math.max(lastActivity, interval.end)
  for (const interval of input.human) lastActivity = Math.max(lastActivity, interval.end)
  for (const interval of input.humanOpen) lastActivity = Math.max(lastActivity, interval.end)
  for (const interval of input.retry) lastActivity = Math.max(lastActivity, interval.end)

  const endedAt = input.running ? Math.max(startedAt, input.now) : Math.max(startedAt, lastActivity)
  const totalMs = Math.max(0, endedAt - startedAt)

  let modelMs = 0
  let tokens = 0

  for (let index = 0; index < assistants.length; index++) {
    const assistant = assistants[index]
    const last = index === assistants.length - 1
    const live = last && input.running

    // `streamed` is the end of the provider request, not the first token.
    // `completed` may be later because it settles tool calls, so the TUI's
    // throughput math uses `created -> streamed` as provider-active time.
    const liveEnd = firstToolRan(assistant) ?? input.now
    const streamed =
      assistant.time.streamed ?? (live ? input.live?.streamedAt ?? liveEnd : undefined)
    if (streamed !== undefined) {
      modelMs += Math.max(0, streamed - assistant.time.created)
    }

    const exact = (assistant.tokens?.output ?? 0) + (assistant.tokens?.reasoning ?? 0)
    if (exact > 0) {
      tokens += exact
    } else if (live && input.live && input.live.chars > 0) {
      tokens += input.live.chars / Math.max(1, input.live.charsPerToken)
    }
  }

  const toolWindow: Interval[] = []
  const shellWindow: Interval[] = []
  const pluginWindow: Interval[] = []
  const tools: ToolUsage[] = []
  let toolCount = 0
  let shellCount = 0
  let pluginCount = 0
  let longestToolMs = 0

  for (const [name, raw] of toolIntervalsByName) {
    const clipped = clipIntervals(raw, startedAt, endedAt)
    if (clipped.length === 0) continue

    toolCount += clipped.length
    toolWindow.push(...clipped)
    tools.push({ name, count: clipped.length, ms: unionMs(clipped) })

    if (isShellTool(name)) {
      shellCount += clipped.length
      shellWindow.push(...clipped)
    } else {
      pluginCount += clipped.length
      pluginWindow.push(...clipped)
    }

    for (const interval of clipped) {
      longestToolMs = Math.max(longestToolMs, interval.end - interval.start)
    }
  }

  tools.sort((left, right) => right.ms - left.ms || left.name.localeCompare(right.name))

  const humanWindow = clipIntervals(
    [...input.human, ...input.humanOpen, ...questionIntervals],
    startedAt,
    endedAt,
  )
  const humanAll = mergeIntervals(humanWindow)
  const humanMs = unionMs(humanAll)
  const humanCount = humanAll.length

  const toolMs = unionMs(toolWindow)
  const humanOverlap = overlapMs(toolWindow, humanAll)
  const toolOnlyMs = Math.max(0, toolMs - humanOverlap)
  const shellMs = Math.max(0, unionMs(shellWindow) - overlapMs(shellWindow, humanAll))
  const pluginMs = Math.max(0, unionMs(pluginWindow) - overlapMs(pluginWindow, humanAll))

  const retryMs = unionMs(clipIntervals(input.retry, startedAt, endedAt))
  const waitMs = Math.max(0, totalMs - modelMs)
  const otherMs = Math.max(0, waitMs - toolOnlyMs - humanMs - retryMs)

  let pendingHumanMs = 0
  for (const interval of [...input.humanOpen, ...questionOpen]) {
    const start = Math.max(startedAt, interval.start)
    const end = Math.max(start, Math.min(input.now, endedAt))
    pendingHumanMs = Math.max(pendingHumanMs, end - start)
  }

  const rate = tokens > 0 && modelMs >= MIN_MODEL_MS ? tokens / (modelMs / 1000) : undefined

  return {
    running: input.running,
    startedAt,
    endedAt,
    totalMs,
    modelMs,
    waitMs,
    toolMs: toolOnlyMs,
    shellMs,
    pluginMs,
    humanMs,
    retryMs,
    otherMs,
    tokens,
    rate,
    toolCount,
    shellCount,
    pluginCount,
    tools,
    humanCount,
    pendingHumanMs,
    longestToolMs,
  }
}

function splitTurns(input: TurnInput): TurnSlice[] {
  const ordered = input.messages
    .slice()
    .sort((left, right) => (messageCreated(left) ?? 0) - (messageCreated(right) ?? 0))

  const starts: number[] = []
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index].type === "user") starts.push(index)
  }

  // No prompts to split on; fall back to the old single-turn selection.
  if (starts.length === 0) {
    return [
      {
        messages: ordered,
        executionStart: input.executionStart,
        running: input.running,
        windowStart: 0,
        windowEnd: input.now,
      },
    ]
  }

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? ordered.length
    const last = index === starts.length - 1
    const windowStart = messageCreated(ordered[start]) ?? 0
    const windowEnd = last
      ? input.now
      : (messageCreated(ordered[starts[index + 1] ?? ordered.length]) ?? input.now)

    return {
      messages: ordered.slice(start, end),
      executionStart: last ? input.executionStart : undefined,
      running: last ? input.running : false,
      windowStart,
      windowEnd,
    }
  })
}

function aggregateTurns(turns: readonly TurnSummary[], running: boolean): TurnSummary {
  let startedAt = Number.POSITIVE_INFINITY
  let endedAt = 0
  let totalMs = 0
  let modelMs = 0
  let waitMs = 0
  let toolMs = 0
  let shellMs = 0
  let pluginMs = 0
  let humanMs = 0
  let retryMs = 0
  let otherMs = 0
  let tokens = 0
  let toolCount = 0
  let shellCount = 0
  let pluginCount = 0
  let humanCount = 0
  let pendingHumanMs = 0
  let longestToolMs = 0

  const tools = new Map<string, { count: number; ms: number }>()

  for (const turn of turns) {
    startedAt = Math.min(startedAt, turn.startedAt)
    endedAt = Math.max(endedAt, turn.endedAt)
    totalMs += turn.totalMs
    modelMs += turn.modelMs
    waitMs += turn.waitMs
    toolMs += turn.toolMs
    shellMs += turn.shellMs
    pluginMs += turn.pluginMs
    humanMs += turn.humanMs
    retryMs += turn.retryMs
    otherMs += turn.otherMs
    tokens += turn.tokens
    toolCount += turn.toolCount
    shellCount += turn.shellCount
    pluginCount += turn.pluginCount
    humanCount += turn.humanCount
    pendingHumanMs = Math.max(pendingHumanMs, turn.pendingHumanMs)
    longestToolMs = Math.max(longestToolMs, turn.longestToolMs)

    for (const tool of turn.tools) {
      const current = tools.get(tool.name)
      if (current) {
        current.count += tool.count
        current.ms += tool.ms
      } else {
        tools.set(tool.name, { count: tool.count, ms: tool.ms })
      }
    }
  }

  const rate =
    tokens > 0 && modelMs >= MIN_MODEL_MS ? tokens / (modelMs / 1000) : undefined

  const aggregated: ToolUsage[] = [...tools.entries()]
    .map(([name, usage]) => ({ name, count: usage.count, ms: usage.ms }))
    .sort((left, right) => right.ms - left.ms || left.name.localeCompare(right.name))

  return {
    running,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    endedAt,
    totalMs,
    modelMs,
    waitMs,
    toolMs,
    shellMs,
    pluginMs,
    humanMs,
    retryMs,
    otherMs,
    tokens,
    rate,
    toolCount,
    shellCount,
    pluginCount,
    tools: aggregated,
    humanCount,
    pendingHumanMs,
    longestToolMs,
  }
}

/**
 * Summarize every turn in the session. Inter-turn idle gaps are excluded: the
 * cumulative figures are sums of the individual turn summaries.
 */
export function summarizeSession(input: TurnInput): SessionSummary | undefined {
  const turns: TurnSummary[] = []

  for (const slice of splitTurns(input)) {
    const inWindow = (interval: Interval) =>
      interval.end > slice.windowStart && interval.start < slice.windowEnd

    const summary = summarizeTurn({
      messages: slice.messages,
      now: input.now,
      running: slice.running,
      executionStart: slice.executionStart,
      human: input.human.filter(inWindow),
      humanOpen: slice.running ? input.humanOpen : [],
      retry: input.retry.filter(inWindow),
      live: slice.running ? input.live : undefined,
    })

    if (summary) turns.push(summary)
  }

  if (turns.length === 0) return undefined

  return { summary: aggregateTurns(turns, input.running), turns }
}

/**
 * Duration for menus, e.g. `250ms`, `1.2s`, `12s`, `2m 5s`, `1h 10m`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`

  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`

  const totalMinutes = Math.floor(seconds / 60)
  const restSeconds = Math.round(seconds % 60)
  if (totalMinutes < 60) {
    return restSeconds > 0 ? `${totalMinutes}m ${restSeconds}s` : `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const restMinutes = totalMinutes % 60
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
}

/**
 * Compact duration for the pill label, e.g. `1.2s`, `12s`, `2m05s`, `1h10m`.
 */
export function formatShortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  const restSeconds = totalSeconds % 60
  if (totalMinutes < 60) {
    return restSeconds > 0
      ? `${totalMinutes}m${restSeconds.toString().padStart(2, "0")}s`
      : `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const restMinutes = totalMinutes % 60
  return restMinutes > 0
    ? `${hours}h${restMinutes.toString().padStart(2, "0")}m`
    : `${hours}h`
}

export function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate) || rate < 0) return "— tok/s"
  if (rate >= 10_000) return `${Math.round(rate / 1000)}k tok/s`
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k tok/s`
  if (rate >= 100) return `${Math.round(rate)} tok/s`
  if (rate >= 10) return `${rate.toFixed(0)} tok/s`
  return `${rate.toFixed(1)} tok/s`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens)}`
}
