import { tool } from "ai";
import { sendThroughGuard, toEmailSend } from "../../adapter/decisions.ts";
import { emailInputSchema, type EmailInput } from "../../adapter/email-schema.ts";
import type { EmailGuard, SendFn } from "../../adapter/types.ts";

export interface GuardedEmailOptions {
  guard: EmailGuard;
  send: SendFn;
  key?: string;
}

/**
 * A Vercel AI SDK tool. Targeted `ai` 7.0.166 (`inputSchema` + `execute`).
 * A refusal or a hold is the tool result text, so the model sees the reason token.
 */
export function guardedEmailTool(options: GuardedEmailOptions) {
  return tool({
    description:
      "Send one email. agent-email-guard checks the budgets, the rate ceiling, repeats and approval rules first. A refusal or a hold is the tool result, with the reason token in brackets.",
    inputSchema: emailInputSchema,
    execute: async (input) => executeGuardedEmail(options, input),
  });
}

export async function executeGuardedEmail(
  options: GuardedEmailOptions,
  input: EmailInput,
): Promise<string> {
  return sendThroughGuard(options.guard, options.send, toEmailSend(input, options.key));
}
