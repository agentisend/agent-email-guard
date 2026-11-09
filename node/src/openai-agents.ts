/**
 * OpenAI Agents SDK: a tool input guardrail for an email-sending tool.
 *
 *   const sendEmail = tool({ name: 'send_email', parameters, execute,
 *     inputGuardrails: [emailInputGuardrail(guard)] });
 *
 * A refusal or hold becomes `rejectContent`: the tool does not run and the
 * model reads the reason token and sentence. An allowed call is recorded
 * when the guardrail passes, so a tool that then fails still counts; wrap the
 * send inside `execute` with guard.wrap instead when you need failures given
 * back. Structural types only: this file does not import the SDK.
 */

import type { Guard, GuardSend } from './guard.js';
import type { Decision } from './decisions.js';

export interface ToolInputGuardrailLike {
  type: 'tool_input';
  name: string;
  run: (data: { toolCall: { arguments: string } }) => Promise<{
    behavior: { type: 'allow' } | { type: 'rejectContent'; message: string };
    outputInfo?: Decision;
  }>;
}

export function emailInputGuardrail(
  guard: Guard,
  options: { name?: string; toGuardSend?: (args: Record<string, unknown>) => GuardSend } = {},
): ToolInputGuardrailLike {
  const map = options.toGuardSend ?? ((args: Record<string, unknown>) => args as unknown as GuardSend);
  return {
    type: 'tool_input',
    name: options.name ?? 'agent-email-guard',
    async run({ toolCall }) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const send = map(args);
      const decision = await guard.check(send);
      if (decision.outcome !== 'allow') {
        return { behavior: { type: 'rejectContent', message: `${decision.outcome} (${decision.reason}): ${decision.message}` }, outputInfo: decision };
      }
      await guard.record(send);
      return { behavior: { type: 'allow' }, outputInfo: decision };
    },
  };
}
