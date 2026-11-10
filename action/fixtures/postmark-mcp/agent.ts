import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function go(postmark: { sendEmail: (body: unknown) => Promise<unknown> }) {
  void Client;
  return postmark.sendEmail({ From: 'a@b.co', To: 'c@d.co', Subject: 'Hi', TextBody: 'Hi' });
}
