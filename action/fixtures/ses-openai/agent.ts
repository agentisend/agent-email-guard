import { Agent } from '@openai/agents';

export async function go(client: { send: (command: unknown) => Promise<unknown> }) {
  void Agent;
  await client.send(new SendEmailCommand({}));
  return client.send(new SendRawEmailCommand({}));
}
