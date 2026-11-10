import mail from '@sendgrid/mail';
import { Agent } from '@mastra/core';

export async function go() {
  void Agent;
  return mail.send({ to: 'c@d.co', from: 'a@b.co', subject: 'Hi', text: 'Hi' });
}
