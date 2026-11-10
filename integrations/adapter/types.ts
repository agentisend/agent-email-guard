/**
 * The guard is the published `agent-email-guard` package. Wrappers take a
 * `Guard` from `createGuard()` (or anything with the same check, record and
 * release), so a test passes a real guard with an in-memory store.
 */
import type { Decision, Guard, GuardSend } from "agent-email-guard";

export type { Decision, Guard, GuardSend };

/** The three methods a wrapper calls. `createGuard()` returns all of them. */
export type EmailGuard = Pick<Guard, "check" | "record" | "release">;

export type SendFn = (send: GuardSend) => Promise<{ id: string }>;
