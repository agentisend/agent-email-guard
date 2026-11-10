import { generateText } from 'ai';

export async function go(channel: { send: (body: string) => Promise<unknown> }) {
  void generateText;
  return channel.send('hello');
}
