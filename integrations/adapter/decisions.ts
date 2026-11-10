import type { Decision, EmailGuard, GuardSend, SendFn } from "./types.ts";

/** Text the model reads when a send does not go out. The reason token stays in brackets. */
export function decisionText(decision: Decision): string {
  if (decision.outcome === "hold_for_approval") {
    return `Approval required. ${decision.message} [${decision.reason}]`;
  }
  return `${decision.message} [${decision.reason}]`;
}

export function toEmailSend(
  input: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text?: string;
    html?: string;
  },
  key?: string,
): GuardSend {
  return {
    to: input.to,
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    subject: input.subject,
    ...(input.text ? { text: input.text } : {}),
    ...(input.html ? { html: input.html } : {}),
    ...(key ? { key } : {}),
  };
}

/**
 * check → send → record, or release when the send throws. `approved` is a
 * person's yes on a held send: it skips the approval rules and nothing else,
 * so budgets, the rate ceiling, loop detection and the kill switch still run.
 */
export async function sendThroughGuard(
  guard: EmailGuard,
  send: SendFn,
  email: GuardSend,
  approved = false,
): Promise<string> {
  const decision = await guard.check(email, approved ? { approved: true } : undefined);
  if (decision.outcome !== "allow") return decisionText(decision);
  return sendAllowed(guard, send, email, decision);
}

/** Sends after an `allow`: record on success, release the decision when the send throws. */
export async function sendAllowed(
  guard: EmailGuard,
  send: SendFn,
  email: GuardSend,
  decision: Decision,
): Promise<string> {
  let result: { id: string };
  try {
    result = await send(email);
  } catch (error) {
    await guard.release(decision);
    throw error;
  }
  await guard.record(email);
  return `Sent ${result.id}`;
}
