/**
 * nodemailer plugin: `transporter.use('compile', nodemailerGuard(policy))`.
 *
 * It runs at nodemailer's compile step, before the message reaches SMTP: a
 * refusal or hold fails sendMail with GuardRefused / ApprovalRequired. An
 * allowed message is recorded right away, so a later SMTP failure still
 * counts toward budgets and loop detection; use guard.wrap(transporter.sendMail)
 * when you want failures given back. To send a held message after a person
 * approved it, send it again with `guardApproved: true` on the message.
 */

import { createGuard, type Guard, type GuardConfig, type GuardSend } from './guard.js';
import { ApprovalRequired, GuardRefused } from './errors.js';

interface CompileMail {
  // nodemailer's MailMessage; typed loosely so this file needs no nodemailer types.
  data: object;
}

function asText(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function nodemailerGuard(guardOrConfig: Guard | GuardConfig = {}): (mail: CompileMail, done: (err?: Error | null) => void) => void {
  const guard: Guard = 'check' in guardOrConfig ? (guardOrConfig as Guard) : createGuard(guardOrConfig as GuardConfig);
  return (mail, done) => {
    const d = mail.data as Record<string, unknown>;
    const send: GuardSend = {
      to: d.to as GuardSend['to'],
      cc: d.cc as GuardSend['cc'],
      bcc: d.bcc as GuardSend['bcc'],
      subject: asText(d.subject),
      text: asText(d.text),
      html: asText(d.html),
      ...(typeof d.guardKey === 'string' ? { key: d.guardKey } : {}),
    };
    const approved = d.guardApproved === true;
    guard
      .check(send, { approved })
      .then(async (decision) => {
        if (decision.outcome === 'refuse') return done(new GuardRefused(decision));
        if (decision.outcome === 'hold_for_approval') {
          return done(
            new ApprovalRequired(decision, () =>
              Promise.reject(new TypeError('Send the message again with guardApproved: true once a person has approved it.')),
            ),
          );
        }
        await guard.record(send);
        done();
      })
      .catch((err: unknown) => done(err as Error));
  };
}
