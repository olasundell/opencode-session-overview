import type { SessionInfo, VcsFileStatus } from "@opencode/client"

export type ChangeTotals = {
  readonly additions: number
  readonly deletions: number
  readonly files: number
}

const AVATAR_COLORS = [
  "#60a5fa",
  "#a78bfa",
  "#f59e0b",
  "#34d399",
  "#fb7185",
  "#22d3ee",
] as const

export function basename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function sumChanges(files: readonly VcsFileStatus[] | undefined): ChangeTotals {
  if (!files || files.length === 0) return { additions: 0, deletions: 0, files: 0 }

  let additions = 0
  let deletions = 0

  for (const file of files) {
    if (Number.isFinite(file.additions)) additions += file.additions
    if (Number.isFinite(file.deletions)) deletions += file.deletions
  }

  return { additions, deletions, files: files.length }
}

/**
 * The root session and every descendant, found by walking `parentID` links.
 */
export function descendantIDs(
  sessions: readonly SessionInfo[],
  rootID: string,
): Set<string> {
  const ids = new Set<string>([rootID])
  let changed = true

  while (changed) {
    changed = false

    for (const session of sessions) {
      if (session.parentID && ids.has(session.parentID) && !ids.has(session.id)) {
        ids.add(session.id)
        changed = true
      }
    }
  }

  return ids
}

export function initials(value: string | undefined): string {
  if (!value) return "?"

  const parts = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)

  if (parts.length === 0) return "?"

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?"
}

export function avatarColor(id: string): string {
  let hash = 0

  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0
  }

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]
}
