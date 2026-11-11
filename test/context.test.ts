import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { currentContextMessage, summarizeContext } from "../src/context.ts"

function system(id: string, text: string): SessionMessageInfo {
  return {
    id,
    type: "system",
    time: { created: 0 },
    text,
  } as unknown as SessionMessageInfo
}

function user(id: string, created: number, text = "hello"): SessionMessageInfo {
  return {
    id,
    type: "user",
    time: { created },
    text,
  } as unknown as SessionMessageInfo
}

function assistant(input: {
  id: string
  created: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
  content?: unknown[]
}): SessionMessageInfo {
  return {
    id: input.id,
    type: "assistant",
    time: { created: input.created },
    agent: "build",
    model: { providerID: "p", id: "m" },
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: {
        read: input.cacheRead ?? 0,
        write: input.cacheWrite ?? 0,
      },
    },
    cost: input.cost,
    content: input.content ?? [],
  } as unknown as SessionMessageInfo
}

function compaction(
  id: string,
  created: number,
  status: "completed" | "running",
  summary = "summary",
): SessionMessageInfo {
  return {
    id,
    type: "compaction",
    time: { created },
    status,
    reason: "auto",
    summary,
  } as unknown as SessionMessageInfo
}

const messages = [
  user("u1", 0),
  assistant({ id: "a1", created: 1_000, input: 1_000, output: 100, cost: 0.01 }),
  user("u2", 2_000),
  assistant({
    id: "a2",
    created: 3_000,
    input: 2_000,
    output: 200,
    reasoning: 50,
    cacheRead: 100,
    cost: 0.02,
  }),
]

test("summarizeContext reports headroom and per-turn growth", () => {
  const context = summarizeContext({
    messages,
    limit: 10_000,
    sessionCost: 0.03,
  })

  assert.ok(context)
  assert.equal(context.total, 2_350)
  assert.equal(context.percent, 24)
  assert.equal(context.free, 7_650)
  assert.equal(context.turnGrowth, 1_250)
  assert.equal(context.turnResultTokens, 0)
  assert.equal(context.turnCost, 0.02)
  assert.equal(context.sessionCost, 0.03)
  assert.equal(context.tokens.cache.read, 100)
})

test("summarizeContext omits limit-derived values without a limit", () => {
  const context = summarizeContext({
    messages,
    sessionCost: 0.03,
  })

  assert.ok(context)
  assert.equal(context.total, 2_350)
  assert.equal(context.percent, undefined)
  assert.equal(context.free, undefined)
})

test("summarizeContext estimates composition and top consumers", () => {
  const tool = {
    type: "tool",
    id: "t1",
    name: "shell",
    state: {
      status: "completed",
      input: { command: "npm run check" },
      content: [{ type: "text", text: "x".repeat(400) }],
    },
    time: { created: 1_000 },
  }
  const composed = [
    system("s1", "x".repeat(400)),
    user("u1", 0, "x".repeat(40)),
    assistant({
      id: "a1",
      created: 1_000,
      input: 500,
      output: 200,
      cacheRead: 300,
      cost: 0.02,
      content: [
        { type: "text", text: "x".repeat(80) },
        tool,
      ],
    }),
  ]

  const context = summarizeContext({
    messages: composed,
    limit: 2_000,
    sessionCost: 0.02,
  })

  assert.ok(context)
  assert.equal(context.total, 1_000)
  assert.equal(context.percent, 50)
  assert.equal(context.composition.system, 100)
  assert.equal(context.composition.results, 100)
  assert.equal(context.composition.overhead, 763)
  assert.equal(context.turnResultTokens, 100)
  assert.equal(context.consumers[0]?.label, "shell")
  assert.equal(context.consumers[0]?.tokens, 107)
  assert.equal(context.consumers[0]?.detail, "npm run check")
})

test("currentContextMessage restarts after a completed compaction", () => {
  const compacted = [
    user("u1", 0),
    assistant({ id: "a1", created: 1_000, input: 1_000, output: 100 }),
    compaction("c1", 1_500, "completed", "x".repeat(80)),
    assistant({ id: "a2", created: 2_000, input: 900, output: 90 }),
  ]

  assert.equal(currentContextMessage(compacted)?.id, "a2")

  const context = summarizeContext({ messages: compacted, sessionCost: 0 })
  assert.ok(context)
  assert.equal(context.total, 990)
  assert.equal(context.composition.summary, 20)
})
