import { createGuard, type GuardConfig } from "agent-email-guard";

/** A real guard with an in-memory store and a fixed clock, for the wrapper tests and examples. */
export function testGuard(config: Omit<GuardConfig, "clock"> = {}) {
  const at = Date.parse("2026-11-10T12:00:00Z");
  return createGuard({ ...config, clock: () => at });
}
