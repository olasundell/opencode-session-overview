import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createTimingTracker, type TimingEvent } from "../src/timing.ts"

const sessionID = "ses_current"

function user(created: number): SessionMessageInfo {
  return { id: "u1", type: "user", time: { created }, text: "hello" } as unknown as SessionMessageInfo
}

function assistant(input: {
  created: number
  streamed?: number
  completed?: number
  content?: unknown[]
}): SessionMessageInfo {
  return {
    id: "a1",
    type: "assistant",
    time: {
      created: input.created,
      ...(input.streamed === undefined ? {} : { streamed: input.streamed }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    agent: "build",
    model: { providerID: "p", id: "m" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: input.content ?? [],
  } as unknown as SessionMessageInfo
}

function harness() {
  const handlers = new Map<string, (event: TimingEvent) => void>()
  let changes = 0

  const tracker = createTimingTracker({
    sessionID,
    onChange: () => {
      changes += 1
    },
  })

  const off = tracker.attach((type, handler) => {
    handlers.set(type, handler)
    return () => handlers.delete(type)
  })

  const emit = (type: string, event: TimingEvent) => {
    handlers.get(type)?.(event)
  }

  return { tracker, emit, changes: () => changes, off }
}

test("tracker estimates the live step and only counts this session", () => {
  const { tracker, emit } = harness()

  emit("session.execution.started", { created: 500, data: { sessionID } })
  emit("session.step.started", {
    created: 1_000,
    data: { sessionID, model: { providerID: "p", id: "m" } },
  })
  emit("session.text.delta", { created: 2_000, data: { sessionID, delta: "abcd" } })
  emit("session.text.delta", {
    created: 2_500,
    data: { sessionID: "ses_other", delta: "ignored" },
  })

  const summary = tracker.summary(
    [user(0), assistant({ created: 1_000 })],
    3_000,
    true,
  )

  assert.ok(summary)
  assert.equal(summary.startedAt, 500)
  assert.equal(summary.totalMs, 2_500)
  assert.equal(summary.tokens, 1)
  assert.equal(summary.modelMs, 1_000)
  assert.equal(summary.waitMs, 1_500)
})

test("tracker attributes permission and retry waits, then closes them", () => {
  const { tracker, emit } = harness()

  emit("session.execution.started", { created: 1_000, data: { sessionID } })
  emit("session.retry.scheduled", { created: 2_000, data: { sessionID } })
  emit("session.step.started", { created: 3_000, data: { sessionID } })
  emit("permission.asked", { created: 4_000, data: { sessionID, id: "perm_1" } })
  emit("permission.replied", {
    created: 5_000,
    data: { sessionID, requestID: "perm_1" },
  })
  emit("session.step.ended", {
    created: 6_000,
    data: { sessionID, tokens: { output: 10, reasoning: 0 } },
  })
  emit("session.execution.succeeded", { created: 7_000, data: { sessionID } })

  const summary = tracker.summary(
    [
      user(0),
      assistant({ created: 1_000, streamed: 6_000, completed: 7_000 }),
    ],
    7_000,
    false,
  )

  assert.ok(summary)
  assert.equal(summary.retryMs, 1_000)
  assert.equal(summary.humanMs, 1_000)
  assert.equal(summary.modelMs, 5_000)
  assert.equal(summary.toolMs, 0)
})
