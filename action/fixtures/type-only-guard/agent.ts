import type { Guard } from 'agent-email-guard';
import { generateText } from 'ai';

export async function go(
  resend: { emails: { send: (body: unknown) => Promise<unknown> } },
  _guard: Guard | null,
) {
  void generateText;
  return resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
