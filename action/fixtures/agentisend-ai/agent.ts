import { generateText } from 'ai';

export async function go(client: { emails: { send: (body: unknown) => Promise<unknown> } }) {
  void generateText;
  return client.emails.send({ from: 'a@b.co', to: 'c@d.co', subject: 'Hi', text: 'Hi' });
}
