import assert from "node:assert/strict"
import test from "node:test"
import type { SessionInfo } from "@opencode/client"
import {
  avatarColor,
  basename,
  descendantIDs,
  initials,
  sumChanges,
} from "../src/overview.ts"

test("basename handles trailing slashes and backslashes", () => {
  assert.equal(basename("/Users/me/project/"), "project")
  assert.equal(basename("C:\\work\\project"), "project")
  assert.equal(basename("/"), "/")
})

test("sumChanges adds per-file additions and deletions", () => {
  assert.deepEqual(
    sumChanges([
      { file: "a.ts", additions: 10, deletions: 2, status: "modified" },
      { file: "b.ts", additions: 5, deletions: 0, status: "added" },
    ]),
    { additions: 15, deletions: 2, files: 2 },
  )
  assert.deepEqual(sumChanges(undefined), { additions: 0, deletions: 0, files: 0 })
})

test("descendantIDs walks nested subagent sessions", () => {
  const sessions = [
    { id: "root", parentID: undefined },
    { id: "child", parentID: "root" },
    { id: "grandchild", parentID: "child" },
    { id: "other", parentID: undefined },
  ] as unknown as SessionInfo[]

  assert.deepEqual([...descendantIDs(sessions, "root")], ["root", "child", "grandchild"])
})

test("initials picks up to two word starts", () => {
  assert.equal(initials("build"), "B")
  assert.equal(initials("code-reviewer"), "CR")
  assert.equal(initials(""), "?")
})

test("avatarColor is deterministic and in the palette", () => {
  assert.equal(avatarColor("ses_abc"), avatarColor("ses_abc"))
  assert.match(avatarColor("ses_abc"), /^#[0-9a-f]{6}$/)
})
