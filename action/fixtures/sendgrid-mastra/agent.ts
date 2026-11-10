import { Agent } from '@mastra/core';

export async function go(sgMail: { send: (body: unknown) => Promise<unknown> }) {
  void Agent;
  return sgMail.send({ to: 'c@d.co', from: 'a@b.co', subject: 'Hi', text: 'Hi' });
}
