import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createTimingRegistry, type TimingEvent } from "../src/timing.ts"

const sessionID = "ses_current"

function user(id: string, created: number): SessionMessageInfo {
  return {
    id,
    type: "user",
    time: { created },
    text: "hello",
  } as unknown as SessionMessageInfo
}

function assistant(input: {
  id: string
  created: number
  streamed?: number
  completed?: number
  content?: unknown[]
}): SessionMessageInfo {
  return {
    id: input.id,
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
  const registry = createTimingRegistry()

  const off = registry.attach((type, handler) => {
    handlers.set(type, handler)
    return () => handlers.delete(type)
  })

  const emit = (type: string, event: TimingEvent) => {
    handlers.get(type)?.(event)
  }

  return { registry, emit, off }
}

test("registry estimates the live step and isolates other sessions", () => {
  const { registry, emit } = harness()

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

  const snapshot = registry.snapshot(
    sessionID,
    [user("u1", 0), assistant({ id: "a1", created: 1_000 })],
    3_000,
    true,
  )

  assert.ok(snapshot)
  assert.equal(snapshot.turns.length, 1)
  const summary = snapshot.summary
  assert.equal(summary.startedAt, 500)
  assert.equal(summary.totalMs, 2_500)
  assert.equal(summary.tokens, 1)
  assert.equal(summary.modelMs, 1_000)
  assert.equal(summary.waitMs, 1_500)
})

test("registry attributes permission and retry waits, then closes them", () => {
  const { registry, emit } = harness()

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

  const snapshot = registry.snapshot(
    sessionID,
    [
      user("u1", 0),
      assistant({ id: "a1", created: 1_000, streamed: 6_000, completed: 7_000 }),
    ],
    7_000,
    false,
  )

  assert.ok(snapshot)
  assert.equal(snapshot.turns.length, 1)
  const summary = snapshot.summary
  assert.equal(summary.retryMs, 1_000)
  assert.equal(summary.humanMs, 1_000)
  assert.equal(summary.modelMs, 5_000)
  assert.equal(summary.toolMs, 0)
})

test("registry keeps waits isolated between sessions", () => {
  const { registry, emit } = harness()
  const a = "ses_a"
  const b = "ses_b"

  emit("session.execution.started", { created: 1_000, data: { sessionID: a } })
  emit("permission.asked", { created: 2_000, data: { sessionID: a, id: "perm_a" } })
  emit("session.execution.started", { created: 1_000, data: { sessionID: b } })
  emit("session.retry.scheduled", { created: 2_000, data: { sessionID: b } })

  const first = registry.snapshot(
    a,
    [user("ua", 0), assistant({ id: "aa", created: 1_000 })],
    3_000,
    true,
  )
  const second = registry.snapshot(
    b,
    [user("ub", 0), assistant({ id: "ab", created: 1_000 })],
    3_000,
    true,
  )

  assert.ok(first)
  assert.ok(second)
  assert.equal(first.summary.pendingHumanMs, 1_000)
  assert.equal(first.summary.retryMs, 0)
  assert.equal(second.summary.pendingHumanMs, 0)
  assert.equal(second.summary.retryMs, 1_000)
})

test("registry keeps live waits across snapshots", () => {
  const { registry, emit } = harness()

  emit("session.execution.started", { created: 1_000, data: { sessionID } })
  emit("permission.asked", { created: 2_000, data: { sessionID, id: "perm_1" } })

  const open = registry.snapshot(
    sessionID,
    [user("u1", 0), assistant({ id: "a1", created: 1_000 })],
    3_000,
    true,
  )

  assert.ok(open)
  assert.equal(open.summary.pendingHumanMs, 1_000)

  emit("permission.replied", {
    created: 4_000,
    data: { sessionID, requestID: "perm_1" },
  })

  const closed = registry.snapshot(
    sessionID,
    [user("u1", 0), assistant({ id: "a1", created: 1_000 })],
    5_000,
    true,
  )

  assert.ok(closed)
  assert.equal(closed.summary.pendingHumanMs, 0)
  assert.equal(closed.summary.humanMs, 2_000)
})

test("prune drops stale wait intervals", () => {
  const { registry, emit } = harness()

  emit("session.execution.started", { created: 1_000, data: { sessionID } })
  emit("permission.asked", { created: 2_000, data: { sessionID, id: "perm_1" } })
  emit("permission.replied", {
    created: 3_000,
    data: { sessionID, requestID: "perm_1" },
  })
  emit("session.execution.succeeded", { created: 4_000, data: { sessionID } })

  const before = registry.snapshot(
    sessionID,
    [user("u1", 0), assistant({ id: "a1", created: 1_000 })],
    4_000,
    false,
  )

  assert.ok(before)
  assert.equal(before.summary.humanMs, 1_000)

  registry.prune(4_000 + 2 * 60 * 60 * 1000 + 1)

  const after = registry.snapshot(
    sessionID,
    [user("u1", 0), assistant({ id: "a1", created: 1_000 })],
    4_000 + 2 * 60 * 60 * 1000 + 1,
    false,
  )

  assert.ok(after)
  assert.equal(after.summary.humanMs, 0)
})
