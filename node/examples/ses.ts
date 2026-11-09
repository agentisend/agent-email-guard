/* eslint-disable no-console -- an example prints what it teaches */
/**
 * AWS SES (SDK v3, SESv2 client): wrap client.send(new SendEmailCommand(...))
 * and tell the guard where SES keeps the recipients and content.
 *
 *   AWS_REGION=us-east-1 npx tsx examples/ses.ts
 */
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { createGuard, type GuardSend } from 'agent-email-guard';

export function fromSesInput(input: SendEmailCommandInput): GuardSend {
  const simple = input.Content?.Simple;
  return {
    to: input.Destination?.ToAddresses ?? [],
    cc: input.Destination?.CcAddresses ?? [],
    bcc: input.Destination?.BccAddresses ?? [],
    subject: simple?.Subject?.Data ?? '',
    text: simple?.Body?.Text?.Data,
    html: simple?.Body?.Html?.Data,
  };
}

export function guardedSesSend(client: Pick<SESv2Client, 'send'>) {
  const guard = createGuard({ key: 'billing-agent', budgets: { perDay: 1000 }, rate: { perMinute: 30 } });
  const send = guard.wrap((input: SendEmailCommandInput) => client.send(new SendEmailCommand(input)), { toGuardSend: fromSesInput });
  return { guard, send };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { send } = guardedSesSend(new SESv2Client({}));
  const out = await send({
    FromEmailAddress: 'billing@yourapp.com',
    Destination: { ToAddresses: ['customer@example.com'] },
    Content: { Simple: { Subject: { Data: 'Your invoice' }, Body: { Text: { Data: 'Invoice #1042 is attached.' } } } },
  });
  console.log(out.MessageId);
}
