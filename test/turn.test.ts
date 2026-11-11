import assert from "node:assert/strict"
import test from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  calibrateRatio,
  clipIntervals,
  formatDuration,
  formatShortDuration,
  formatRate,
  mergeIntervals,
  overlapMs,
  summarizeSession,
  summarizeTurn,
  unionMs,
} from "../src/turn.ts"

const usage = { input: 0, output: 40, reasoning: 10, cache: { read: 0, write: 0 } }

function user(created: number): SessionMessageInfo {
  return {
    id: "u1",
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
  output?: number
  reasoning?: number
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
    tokens: {
      ...usage,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
    },
    content: input.content ?? [],
  } as unknown as SessionMessageInfo
}

test("mergeIntervals merges overlaps and drops empty intervals", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 20 },
      { start: 30, end: 40 },
      { start: 35, end: 38 },
    ]),
    [
      { start: 0, end: 15 },
      { start: 30, end: 40 },
    ],
  )
})

test("unionMs and overlapMs share one interval set", () => {
  const left = [{ start: 0, end: 10 }]
  const right = [{ start: 5, end: 15 }]

  assert.equal(unionMs(left), 10)
  assert.equal(unionMs([...left, ...right]), 15)
  assert.equal(overlapMs(left, right), 5)
})

test("clipIntervals keeps only the overlapping window", () => {
  assert.deepEqual(
    clipIntervals(
      [
        { start: 0, end: 5 },
        { start: 8, end: 20 },
      ],
      10,
      15,
    ),
    [{ start: 10, end: 15 }],
  )
})

test("calibrateRatio blends toward the observed ratio", () => {
  assert.equal(calibrateRatio(undefined, 400, 100), 4)
  assert.ok(Math.abs((calibrateRatio(4, 800, 100) ?? 0) - 5.2) < 1e-9)
  assert.equal(calibrateRatio(4, 0, 100), 4)
  assert.equal(calibrateRatio(4, 400, 0), 4)
  assert.equal(calibrateRatio(4, 10, 100), 4)
})

test("formatDuration and formatShortDuration agree on the shapes", () => {
  assert.equal(formatDuration(0), "0s")
  assert.equal(formatDuration(250), "250ms")
  assert.equal(formatDuration(1_500), "1.5s")
  assert.equal(formatDuration(12_000), "12s")
  assert.equal(formatDuration(125_000), "2m 5s")
  assert.equal(formatDuration(3_900_000), "1h 5m")

  assert.equal(formatShortDuration(1_500), "1.5s")
  assert.equal(formatShortDuration(125_000), "2m05s")
  assert.equal(formatShortDuration(3_900_000), "1h05m")
})

test("formatRate keeps the token suffix and compacts thousands", () => {
  assert.equal(formatRate(undefined), "— tok/s")
  assert.equal(formatRate(8.44), "8.4 tok/s")
  assert.equal(formatRate(42.4), "42 tok/s")
  assert.equal(formatRate(1200), "1.2k tok/s")
})

test("summarizeTurn attributes generation, tools and human waits", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 5_000,
      completed: 8_000,
      output: 40,
      reasoning: 10,
      content: [
        {
          type: "tool",
          id: "t1",
          name: "shell",
          state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
          time: { created: 4_000, ran: 5_000, completed: 8_000 },
        },
      ],
    }),
    assistant({
      id: "a2",
      created: 8_000,
      streamed: 12_000,
      completed: 12_000,
      output: 20,
    }),
  ]

  const summary = summarizeTurn({
    messages,
    now: 12_000,
    running: false,
    human: [{ start: 6_000, end: 7_000 }],
    humanOpen: [],
    retry: [],
  })

  assert.ok(summary)
  assert.equal(summary.totalMs, 12_000)
  assert.equal(summary.modelMs, 8_000)
  assert.equal(summary.tokens, 70)
  assert.equal(summary.rate, 70 / 8)
  assert.equal(summary.toolMs, 2_000)
  assert.equal(summary.shellMs, 2_000)
  assert.equal(summary.pluginMs, 0)
  assert.equal(summary.shellCount, 1)
  assert.equal(summary.pluginCount, 0)
  assert.equal(summary.humanMs, 1_000)
  assert.equal(summary.waitMs, 4_000)
  assert.equal(summary.otherMs, 1_000)
  assert.equal(summary.toolCount, 1)
  assert.equal(summary.humanCount, 1)
  assert.deepEqual(summary.tools, [{ name: "shell", count: 1, ms: 3_000 }])
})

test("summarizeTurn splits shell and plugin/MCP tool time", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 2_000,
      completed: 8_000,
      content: [
        {
          type: "tool",
          id: "t1",
          name: "shell",
          state: { status: "completed", input: {}, content: [] },
          time: { created: 2_000, ran: 2_000, completed: 3_000 },
        },
        {
          type: "tool",
          id: "t2",
          name: "istra_lookup",
          state: { status: "completed", input: {}, content: [] },
          time: { created: 4_000, ran: 4_000, completed: 6_000 },
        },
        {
          type: "tool",
          id: "t3",
          name: "edit",
          state: { status: "completed", input: {}, content: [] },
          time: { created: 6_000, ran: 6_000, completed: 7_000 },
        },
      ],
    }),
  ]

  const summary = summarizeTurn({
    messages,
    now: 8_000,
    running: false,
    human: [],
    humanOpen: [],
    retry: [],
  })

  assert.ok(summary)
  assert.equal(summary.toolMs, 4_000)
  assert.equal(summary.shellMs, 1_000)
  assert.equal(summary.pluginMs, 3_000)
  assert.equal(summary.shellCount, 1)
  assert.equal(summary.pluginCount, 2)
})

test("summarizeSession sums turns without inter-turn idle gaps", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 3_000,
      completed: 4_000,
      output: 30,
      content: [
        {
          type: "tool",
          id: "t1",
          name: "shell",
          state: { status: "completed", input: {}, content: [] },
          time: { created: 2_000, ran: 2_000, completed: 3_000 },
        },
      ],
    }),
    user(10_000),
    assistant({
      id: "a2",
      created: 11_000,
      streamed: 15_000,
      completed: 16_000,
      output: 20,
      content: [
        {
          type: "tool",
          id: "t2",
          name: "istra_lookup",
          state: { status: "completed", input: {}, content: [] },
          time: { created: 12_000, ran: 12_000, completed: 13_000 },
        },
      ],
    }),
  ]

  const session = summarizeSession({
    messages,
    now: 16_000,
    running: false,
    human: [],
    humanOpen: [],
    retry: [],
  })

  assert.ok(session)
  assert.equal(session.turns.length, 2)
  assert.equal(session.summary.startedAt, 0)
  assert.equal(session.summary.endedAt, 16_000)
  assert.equal(session.summary.totalMs, 10_000)
  assert.equal(session.summary.modelMs, 6_000)
  assert.equal(session.summary.waitMs, 4_000)
  assert.equal(session.summary.shellMs, 1_000)
  assert.equal(session.summary.pluginMs, 1_000)
  assert.equal(session.summary.toolMs, 2_000)
  assert.equal(session.summary.tokens, 50)
  assert.equal(session.summary.rate, 50 / 6)
  assert.equal(session.summary.shellCount, 1)
  assert.equal(session.summary.pluginCount, 1)
  assert.equal(session.summary.otherMs, 2_000)
})

test("summarizeSession keeps human waits inside their own turn", () => {
  const messages = [
    user(0),
    assistant({ id: "a1", created: 1_000, streamed: 2_000, completed: 2_000 }),
    user(10_000),
    assistant({ id: "a2", created: 11_000, streamed: 12_000, completed: 12_000 }),
  ]

  const session = summarizeSession({
    messages,
    now: 12_000,
    running: false,
    human: [{ start: 11_500, end: 11_800 }],
    humanOpen: [],
    retry: [],
  })

  assert.ok(session)
  assert.equal(session.turns.length, 2)
  assert.equal(session.turns[0]?.humanMs, 0)
  assert.equal(session.turns[0]?.endedAt, 2_000)
  assert.equal(session.turns[1]?.humanMs, 300)
  assert.equal(session.summary.humanMs, 300)
})

test("summarizeTurn accepts newest-first message lists", () => {
  const messages = [
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 2_000,
      completed: 5_000,
      output: 40,
      reasoning: 10,
    }),
    user(0),
  ]

  const summary = summarizeTurn({
    messages,
    now: 5_000,
    running: false,
    human: [],
    humanOpen: [],
    retry: [],
  })

  assert.ok(summary)
  assert.equal(summary.totalMs, 5_000)
  assert.equal(summary.modelMs, 1_000)
  assert.equal(summary.tokens, 50)
  assert.equal(summary.rate, 50)
  assert.equal(summary.waitMs, 4_000)
})

test("summarizeTurn estimates the live step from streamed characters", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
    }),
  ]

  const summary = summarizeTurn({
    messages,
    now: 5_000,
    running: true,
    human: [],
    humanOpen: [],
    retry: [],
    live: { chars: 20, charsPerToken: 4 },
  })

  assert.ok(summary)
  assert.equal(summary.totalMs, 5_000)
  assert.equal(summary.modelMs, 4_000)
  assert.equal(summary.tokens, 5)
  assert.equal(summary.rate, 5 / 4)
  assert.equal(summary.waitMs, 1_000)
})

test("a question tool counts as waiting on the human, not tool time", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 2_000,
      completed: 7_000,
      content: [
        {
          type: "tool",
          id: "q1",
          name: "question",
          state: { status: "completed", input: {}, content: [{ type: "text", text: "yes" }] },
          time: { created: 1_000, ran: 2_000, completed: 6_000 },
        },
      ],
    }),
  ]

  const summary = summarizeTurn({
    messages,
    now: 7_000,
    running: false,
    human: [],
    humanOpen: [],
    retry: [],
  })

  assert.ok(summary)
  assert.equal(summary.modelMs, 1_000)
  assert.equal(summary.waitMs, 6_000)
  assert.equal(summary.humanMs, 4_000)
  assert.equal(summary.otherMs, 2_000)
  assert.equal(summary.toolMs, 0)
  assert.equal(summary.toolCount, 0)
  assert.equal(summary.humanCount, 1)
})

test("an open question reports pending human time", () => {
  const messages = [
    user(0),
    assistant({
      id: "a1",
      created: 1_000,
      streamed: 1_000,
      content: [
        {
          type: "tool",
          id: "q1",
          name: "question",
          state: { status: "running", input: {}, metadata: {} },
          time: { created: 1_000, ran: 2_000 },
        },
      ],
    }),
  ]

  const summary = summarizeTurn({
    messages,
    now: 5_000,
    running: true,
    human: [],
    humanOpen: [],
    retry: [],
  })

  assert.ok(summary)
  assert.equal(summary.pendingHumanMs, 3_000)
  assert.equal(summary.humanMs, 3_000)
  assert.equal(summary.modelMs, 0)
  assert.equal(summary.waitMs, 5_000)
  assert.equal(summary.otherMs, 2_000)
})
