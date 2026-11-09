/**
 * Vercel AI SDK: an agent tool whose send is wrapped. A refusal or a hold
 * becomes the tool's result, so the model reads the reason and the sentence
 * instead of retrying blind; nothing is sent.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { ApprovalRequired, createGuard, GuardRefused, type GuardSend } from 'agent-email-guard';

export type Transport = (email: GuardSend & { from: string }) => Promise<{ id: string }>;

export function sendEmailTool(transport: Transport, from = 'agent@yourapp.com') {
  const guard = createGuard({
    key: 'assistant',
    budgets: { perHour: 20, perDay: 100 },
    rate: { perMinute: 5 },
    approval: { newRecipients: true },
  });
  const send = guard.wrap(transport);

  const sendEmail = tool({
    description: 'Send one email to a customer. Returns sent, held for a person, or refused with the reason.',
    inputSchema: z.object({ to: z.string().email(), subject: z.string(), text: z.string() }),
    execute: async ({ to, subject, text }) => {
      try {
        const { id } = await send({ from, to, subject, text });
        return { status: 'sent' as const, id };
      } catch (err) {
        if (err instanceof ApprovalRequired) return { status: 'held_for_approval' as const, reason: err.reason, message: err.message };
        if (err instanceof GuardRefused) return { status: 'refused' as const, reason: err.reason, message: err.message };
        throw err;
      }
    },
  });
  return { guard, sendEmail };
}

// Usage with a model:
//   const { sendEmail } = sendEmailTool(myTransport);
//   await generateText({ model, tools: { sendEmail }, prompt: 'Tell ana@example.com her refund went through.' });
