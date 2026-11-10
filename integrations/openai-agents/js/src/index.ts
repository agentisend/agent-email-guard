import { Agent, RunContext, runToolInputGuardrails, tool } from "@openai/agents";
import { emailInputGuardrail } from "agent-email-guard/openai-agents";
import { toEmailSend } from "../../../adapter/decisions.ts";
import { emailInputSchema, type EmailInput } from "../../../adapter/email-schema.ts";
import type { Guard, SendFn } from "../../../adapter/types.ts";

const TOOL_NAME = "send_email";

export interface GuardedEmailOptions {
  guard: Guard;
  send: SendFn;
  /** Guard key. Passed through on the send the guardrail checks. */
  key?: string;
}

/**
 * An OpenAI Agents SDK function tool whose input guardrail is the one
 * `agent-email-guard` ships (`agent-email-guard/openai-agents`).
 *
 * Targeted `@openai/agents` 0.21.0. The SDK runs `inputGuardrails` before
 * `invoke`. A refusal or a hold is `rejectContent`: the tool body does not run
 * and the model reads `refuse (agent_budget_exceeded): ...`. An allowed call
 * is recorded when the guardrail passes, so a send that then fails still
 * counts against the budget.
 */
export function guardedEmailTool(options: GuardedEmailOptions) {
  return tool({
    name: TOOL_NAME,
    description:
      "Send one email. The agent-email-guard tool input guardrail checks the budgets, the rate ceiling, repeats and approval rules before the send. A refusal or a hold is the guardrail message, with the reason token.",
    parameters: emailInputSchema,
    // A transport failure must reach the caller. The default handler turns it into a string.
    errorFunction: null,
    inputGuardrails: [
      emailInputGuardrail(options.guard, {
        toGuardSend: (args) => toEmailSend(emailInputSchema.parse(args), options.key),
      }),
    ],
    execute: async (input) => {
      const result = await options.send(toEmailSend(input, options.key));
      return `Sent ${result.id}`;
    },
  });
}

/**
 * Runs the SDK's tool input guardrail, then invokes the tool only when the
 * guardrail allows. This is the same order `Runner` uses, without a model call.
 */
export async function applyEmailGuardrail(
  emailTool: ReturnType<typeof guardedEmailTool>,
  input: EmailInput,
): Promise<string> {
  const agent = new Agent({
    name: "mail",
    instructions: "Send the email the person asked for.",
  });
  const context = new RunContext({});
  const argumentsText = JSON.stringify(input);
  const verdict = await runToolInputGuardrails({
    guardrails: emailTool.inputGuardrails,
    context,
    agent,
    toolCall: {
      type: "function_call",
      callId: "call-1",
      name: emailTool.name,
      status: "completed",
      arguments: argumentsText,
    },
  });
  if (verdict.type === "reject") return verdict.message;
  const sent = await emailTool.invoke(context, argumentsText);
  return String(sent);
}
