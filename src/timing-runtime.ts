import {
  createTimingRegistry,
  type TimingRegistry,
} from "./timing.ts"

const registries = new Map<string, TimingRegistry>()

export function ensureTimingRegistry(serverID: string): TimingRegistry {
  let registry = registries.get(serverID)

  if (!registry) {
    registry = createTimingRegistry()
    registries.set(serverID, registry)
  }

  return registry
}

export function getTimingRegistry(
  serverID: string,
): TimingRegistry | undefined {
  return registries.get(serverID)
}

export function pruneTimingRegistries(now: number): void {
  for (const registry of registries.values()) registry.prune(now)
}
