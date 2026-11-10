import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { decisionText, sendAllowed, sendThroughGuard, toEmailSend } from "../../adapter/decisions.ts";
import { emailInputSchema, type EmailInput } from "../../adapter/email-schema.ts";
import type { EmailGuard, SendFn } from "../../adapter/types.ts";

export interface MastraResume {
  approved?: boolean;
}

export interface MastraSuspendPayload {
  reason: string;
  message: string;
}

export interface MastraToolContext {
  agent?: {
    suspend?: (payload: MastraSuspendPayload) => Promise<unknown> | unknown;
    resumeData?: MastraResume;
  };
}

export interface GuardedEmailOptions {
  guard: EmailGuard;
  send: SendFn;
  key?: string;
}

/**
 * Mastra tool. Targeted `@mastra/core` 1.82.0. `createTool` execute is
 * `(input, context)`. `hold_for_approval` calls `context.agent.suspend`.
 * A resume with `approved: true` sends through `check(send, { approved: true })`,
 * which skips the approval rules and still applies the budgets, the rate
 * ceiling and loop detection.
 */
export function guardedEmailTool(options: GuardedEmailOptions) {
  return createTool({
    id: "send_email",
    description:
      "Send one email. agent-email-guard checks the budgets, the rate ceiling, repeats and approval rules first. A hold suspends the tool for a person to approve.",
    inputSchema: emailInputSchema,
    outputSchema: z.string(),
    suspendSchema: z.object({
      reason: z.string(),
      message: z.string(),
    }),
    resumeSchema: z.object({
      approved: z.boolean(),
    }),
    execute: async (input, context) => executeGuardedEmail(options, input, context),
  });
}

export async function executeGuardedEmail(
  options: GuardedEmailOptions,
  input: EmailInput,
  context?: MastraToolContext,
): Promise<string | unknown> {
  const email = toEmailSend(input, options.key);
  const resumeData = context?.agent?.resumeData;
  if (resumeData?.approved === true) {
    return sendThroughGuard(options.guard, options.send, email, true);
  }
  if (resumeData) return "Approval required. The send was not approved.";
  const decision = await options.guard.check(email);
  if (decision.outcome === "refuse") return decisionText(decision);
  if (decision.outcome === "hold_for_approval") {
    const suspend = context?.agent?.suspend;
    if (suspend) return suspend({ reason: decision.reason, message: decision.message });
    return decisionText(decision);
  }
  return sendAllowed(options.guard, options.send, email, decision);
}
