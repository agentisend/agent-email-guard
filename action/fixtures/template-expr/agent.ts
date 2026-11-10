import { generateText } from 'ai';

void generateText;
export async function go(resend: { emails: { send: (body: unknown) => Promise<unknown> } }) {
  const label = `id ${resend.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' })}`;
  return label;
}
