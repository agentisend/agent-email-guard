/* eslint-disable no-console -- an example prints what it teaches */
/**
 * Resend SDK: wrap resend.emails.send. Resend returns { data, error } instead
 * of throwing, so turn an error into a throw: the guard then gives the
 * budget back and does not count the send.
 *
 *   RESEND_API_KEY=re_... npx tsx examples/resend.ts
 */
import { Resend, type CreateEmailOptions } from 'resend';
import { createGuard } from 'agent-email-guard';

export function guardedResendSend(resend: Pick<Resend, 'emails'>) {
  const guard = createGuard({ key: 'onboarding-agent', budgets: { perDay: 500 }, approval: { newRecipients: false } });
  const send = guard.wrap(async (email: CreateEmailOptions) => {
    const { data, error } = await resend.emails.send(email);
    if (error) throw new Error(`Resend refused the send: ${error.message}`);
    return data;
  });
  return { guard, send };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { send } = guardedResendSend(new Resend(process.env.RESEND_API_KEY));
  const data = await send({ from: 'hello@yourapp.com', to: 'new-user@example.com', subject: 'Welcome', text: 'Glad you are here.' });
  console.log(data?.id);
}
