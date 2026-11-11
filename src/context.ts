import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"

export type ContextConsumer = {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly tokens: number
}

export type ContextComposition = {
  readonly system: number
  readonly conversation: number
  readonly results: number
  readonly summary: number
  readonly overhead: number
}

export type ContextSnapshot = {
  readonly total: number
  readonly limit?: number
  readonly percent?: number
  readonly free?: number
  readonly composition: ContextComposition
  readonly consumers: readonly ContextConsumer[]
  readonly turnGrowth?: number
  readonly turnResultTokens: number
  readonly turnCost: number
  readonly sessionCost: number
  readonly tokens: TokenUsageInfo
}

type AssistantWithUsage = SessionMessageAssistant & { tokens: TokenUsageInfo }

type Estimate = {
  system: number
  conversation: number
  results: number
  summary: number
  consumers: ContextConsumer[]
}

const CHARS_PER_TOKEN = 4

function estimate(chars: number): number {
  return chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0
}

function totalTokens(tokens: TokenUsageInfo): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  )
}

function preview(value: string, max = 48): string | undefined {
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""

  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function toolHint(input: unknown): string | undefined {
  if (typeof input === "string") return preview(input, 40)
  if (!input || typeof input !== "object") return undefined

  const record = input as Record<string, unknown>
  for (const key of [
    "command",
    "filePath",
    "path",
    "file",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = record[key]
    if (typeof value === "string") {
      const hint = preview(value, 40)
      if (hint) return hint
    }
  }

  return undefined
}

function toolOutputText(state: SessionMessageAssistantTool["state"]): string {
  if (state.status !== "completed" && state.status !== "error") return ""

  const content = state.content ?? []
  const text = content
    .map((item) => (item.type === "text" ? item.text : item.uri))
    .join("")

  if (state.status === "error") return `${text}${state.error.message}`
  return text
}

function estimateMessage(message: SessionMessageInfo): Estimate {
  const result: Estimate = {
    system: 0,
    conversation: 0,
    results: 0,
    summary: 0,
    consumers: [],
  }

  if (message.type === "system" || message.type === "synthetic" || message.type === "skill") {
    result.system = estimate(message.text.length)
    return result
  }

  if (message.type === "user") {
    const tokens = estimate(message.text.length)
    result.conversation = tokens
    if (tokens > 0) {
      result.consumers.push({
        id: message.id,
        label: "user",
        detail: preview(message.text),
        tokens,
      })
    }
    return result
  }

  if (message.type === "assistant") {
    let textChars = 0
    let previewText = ""

    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        textChars += part.text.length
        if (!previewText) previewText = part.text
        continue
      }

      const inputTokens = estimate(toolInputText(part.state.input).length)
      const outputTokens = estimate(toolOutputText(part.state).length)
      result.conversation += inputTokens
      result.results += outputTokens

      const tokens = inputTokens + outputTokens
      if (tokens > 0) {
        result.consumers.push({
          id: part.id,
          label: part.name,
          detail: toolHint(part.state.input),
          tokens,
        })
      }
    }

    const tokens = estimate(textChars)
    result.conversation += tokens
    if (tokens > 0) {
      result.consumers.push({
        id: message.id,
        label: "assistant",
        detail: preview(previewText),
        tokens,
      })
    }

    return result
  }

  if (message.type === "shell") {
    const tokens = estimate(
      message.command.length + (message.output?.output.length ?? 0),
    )
    result.results += tokens
    if (tokens > 0) {
      result.consumers.push({
        id: message.id,
        label: "shell",
        detail: preview(message.command),
        tokens,
      })
    }
    return result
  }

  if (message.type === "compaction" && message.status === "completed") {
    result.summary = estimate(message.summary.length)
    return result
  }

  return result
}

function addEstimate(target: Estimate, source: Estimate) {
  target.system += source.system
  target.conversation += source.conversation
  target.results += source.results
  target.summary += source.summary
  target.consumers.push(...source.consumers)
}

/**
 * The assistant step whose tokens fill the context window now: the latest one
 * after the last completed compaction and before the revert boundary. Mirrors
 * the client helper the TUI and desktop use.
 */
export function currentContextMessage(
  messages: readonly SessionMessageInfo[],
  boundary?: string,
): AssistantWithUsage | undefined {
  const boundaryIndex = boundary
    ? messages.findIndex((message) => message.id === boundary)
    : -1

  if (boundary && boundaryIndex === -1) return undefined

  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) =>
      message.type === "compaction" &&
      message.status === "completed" &&
      index < end,
  )

  return messages.findLast(
    (message, index) =>
      message.type === "assistant" &&
      message.tokens !== undefined &&
      index > compactionIndex &&
      index < end,
  ) as AssistantWithUsage | undefined
}

export function summarizeContext(input: {
  readonly messages: readonly SessionMessageInfo[]
  readonly limit?: number
  readonly sessionCost: number
  readonly revertMessageID?: string
}): ContextSnapshot | undefined {
  const current = currentContextMessage(input.messages, input.revertMessageID)
  if (!current) return undefined

  const tokens = current.tokens
  const total = totalTokens(tokens)
  const limit = input.limit && input.limit > 0 ? input.limit : undefined
  const percent = limit ? Math.round((total / limit) * 100) : undefined
  const free = limit ? Math.max(0, limit - total) : undefined

  const compactionIndex = input.messages.findLastIndex(
    (message) =>
      message.type === "compaction" && message.status === "completed",
  )
  const visible = input.messages.slice(compactionIndex + 1)
  const estimateResult: Estimate = {
    system: 0,
    conversation: 0,
    results: 0,
    summary: 0,
    consumers: [],
  }

  const systemMessage = input.messages.findLast(
    (message) => message.type === "system",
  )
  if (systemMessage) {
    estimateResult.system += estimate(systemMessage.text.length)
  }

  if (compactionIndex >= 0) {
    const compaction = input.messages[compactionIndex]
    if (compaction?.type === "compaction" && compaction.status === "completed") {
      estimateResult.summary += estimate(compaction.summary.length)
    }
  }

  for (const message of visible) {
    if (message.type === "system" || message.type === "compaction") continue
    addEstimate(estimateResult, estimateMessage(message))
  }

  let system = estimateResult.system
  let conversation = estimateResult.conversation
  let results = estimateResult.results
  let summary = estimateResult.summary

  const estimated = system + conversation + results + summary
  if (estimated > total && estimated > 0) {
    const scale = total / estimated
    system = Math.round(system * scale)
    conversation = Math.round(conversation * scale)
    results = Math.round(results * scale)
    summary = Math.round(summary * scale)
    estimateResult.consumers = estimateResult.consumers.map((consumer) => ({
      ...consumer,
      tokens: Math.max(0, Math.round(consumer.tokens * scale)),
    }))
  }

  let excess = system + conversation + results + summary - total
  for (const key of ["conversation", "results", "system", "summary"] as const) {
    if (excess <= 0) break

    const value = key === "system" ? system : key === "conversation" ? conversation : key === "results" ? results : summary
    const reduce = Math.min(value, excess)
    if (key === "system") system -= reduce
    else if (key === "conversation") conversation -= reduce
    else if (key === "results") results -= reduce
    else summary -= reduce
    excess -= reduce
  }

  const overhead = Math.max(0, total - (system + conversation + results + summary))

  const lastUser = input.messages.findLastIndex(
    (message) => message.type === "user",
  )
  const currentTurn =
    lastUser >= 0 ? input.messages.slice(lastUser) : input.messages
  const previousTurn = lastUser > 0 ? input.messages.slice(0, lastUser) : []
  const currentStep = currentContextMessage(currentTurn, input.revertMessageID)
  const previousStep = previousTurn.length
    ? currentContextMessage(previousTurn, input.revertMessageID)
    : undefined
  const turnGrowth =
    currentStep && previousStep
      ? totalTokens(currentStep.tokens) - totalTokens(previousStep.tokens)
      : undefined

  let turnResultTokens = 0
  let turnCost = 0

  for (const message of currentTurn) {
    if (message.type === "assistant") {
      turnCost += message.cost ?? 0
      for (const part of message.content) {
        if (part.type === "tool") {
          turnResultTokens += estimate(toolOutputText(part.state).length)
        }
      }
    } else if (message.type === "shell") {
      turnResultTokens += estimate(message.output?.output.length ?? 0)
    } else if (message.type === "compaction" && message.status === "completed") {
      turnCost += message.cost ?? 0
    }
  }

  const consumers = estimateResult.consumers
    .filter((consumer) => consumer.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5)

  return {
    total,
    limit,
    percent,
    free,
    composition: { system, conversation, results, summary, overhead },
    consumers,
    turnGrowth,
    turnResultTokens,
    turnCost,
    sessionCost: input.sessionCost,
    tokens,
  }
}
