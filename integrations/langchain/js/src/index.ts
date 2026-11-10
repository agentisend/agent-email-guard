import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { decisionText, sendAllowed, sendThroughGuard, toEmailSend } from "../../../adapter/decisions.ts";
import { emailInputSchema, type EmailInput } from "../../../adapter/email-schema.ts";
import type { EmailGuard, SendFn } from "../../../adapter/types.ts";

export interface GuardedEmailOptions {
  guard: EmailGuard;
  send: SendFn;
  key?: string;
}

/**
 * LangChain tool. Targeted `@langchain/core` 1.3.5, `langchain` 1.6.3, and
 * `@langchain/langgraph` 1.7.2. `hold_for_approval` calls `interrupt()`.
 * LangGraph runs the node again on resume: a hold records nothing, so the
 * second `check` holds again and `interrupt()` returns the person's answer.
 * An approve sends through `check(send, { approved: true })`, which skips the
 * approval rules and still applies the budgets, the rate ceiling and loop
 * detection. A refusal is tool text and does not interrupt.
 */
export function guardedEmailTool(options: GuardedEmailOptions) {
  return tool(
    async (input: EmailInput) => {
      const email = toEmailSend(input, options.key);
      const decision = await options.guard.check(email);
      if (decision.outcome === "refuse") return decisionText(decision);
      if (decision.outcome === "hold_for_approval") {
        const resume: unknown = interrupt({
          outcome: "hold_for_approval",
          reason: decision.reason,
          message: decision.message,
          to: input.to,
          subject: input.subject,
        });
        if (readAction(resume) !== "approve") return decisionText(decision);
        return sendThroughGuard(options.guard, options.send, email, true);
      }
      return sendAllowed(options.guard, options.send, email, decision);
    },
    {
      name: "send_email",
      description:
        "Send one email. agent-email-guard checks the budgets, the rate ceiling, repeats and approval rules first. A hold pauses on a LangGraph interrupt.",
      schema: emailInputSchema,
    },
  );
}

function readAction(value: unknown): string {
  if (typeof value !== "object" || value === null || !("action" in value)) return "";
  const action = value.action;
  return typeof action === "string" ? action : "";
}
