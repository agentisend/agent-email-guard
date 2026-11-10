import { generateText } from 'ai';

export async function go(resend: { emails: { send: (body: unknown) => Promise<unknown> } }) {
  void generateText;
  return resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
