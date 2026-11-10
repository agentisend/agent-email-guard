import { generateText } from 'ai';

export async function go(stripe: { messages: { create: (body: unknown) => Promise<unknown> } }) {
  void generateText;
  return stripe.messages.create({ body: 'hello' });
}
