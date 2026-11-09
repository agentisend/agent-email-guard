/* eslint-disable no-console -- an example prints what it teaches */
/**
 * nodemailer: wrap transporter.sendMail. The message shape (to, cc, bcc,
 * subject, text, html) is what the guard reads, so no mapping is needed.
 *
 *   SMTP_URL=smtp://user:pass@smtp.example.com:587 npx tsx examples/nodemailer.ts
 */
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { createGuard } from 'agent-email-guard';

export function guardedSendMail(transporter: Transporter) {
  const guard = createGuard({
    key: 'support-agent',
    budgets: { perHour: 50, perDay: 300 },
    rate: { perMinute: 10 },
    approval: { recipients: ['@bigcustomer.com'] },
  });
  return { guard, sendMail: guard.wrap((mail: SendMailOptions) => transporter.sendMail(mail)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sendMail } = guardedSendMail(nodemailer.createTransport(process.env.SMTP_URL));
  const info = await sendMail({ from: 'agent@yourapp.com', to: 'customer@example.com', subject: 'Your ticket', text: 'We fixed it.' });
  console.log(info.messageId);
}
