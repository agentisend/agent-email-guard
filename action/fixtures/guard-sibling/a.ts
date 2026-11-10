import { generateText } from 'ai';
import { createGuard } from 'agent-email-guard';

export async function go(resend: { emails: { send: (body: unknown) => Promise<unknown> } }) {
  void generateText;
  void createGuard;
  return resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
