/* eslint-disable no-console -- an example prints what it teaches */
/**
 * AgentiSend, two ways.
 *
 * 1. Local guard around the SDK: same as any provider.
 * 2. Hosted: the same rules enforced by the API on the key itself, shared by
 *    every process using the key, where the agent cannot remove them. The
 *    budget, ceiling and kill switch live on the key (set them in the console
 *    or lower them with setLimits); approval holds land in the console queue.
 *
 *   AGENTISEND_API_KEY=as_... AGENTISEND_KEY_ID=... npx tsx examples/agentisend.ts
 */
import type { AgentiSend } from 'agentisend';
import { createGuard } from 'agent-email-guard';
import { createHostedGuard } from 'agent-email-guard/agentisend';

type Email = Parameters<AgentiSend['emails']['send']>[0];

export function guardedAgentiSend(client: Pick<AgentiSend, 'emails'>) {
  const guard = createGuard({ key: 'agent-1', budgets: { perHour: 100 }, rate: { perMinute: 20 } });
  return { guard, send: guard.wrap((email: Email) => client.emails.send(email)) };
}

export function hostedAgentiSend(options: { apiKey: string; keyId?: string; fetch?: typeof fetch; baseUrl?: string }) {
  return createHostedGuard(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hosted = hostedAgentiSend({ apiKey: process.env.AGENTISEND_API_KEY ?? '', keyId: process.env.AGENTISEND_KEY_ID });
  const email = { from: 'agent@yourapp.com', to: 'customer@example.com', subject: 'Your order shipped', text: 'Tracking: 1Z999.' };
  const decision = await hosted.check(email);
  console.log(decision.outcome, decision.message);
  if (decision.outcome === 'allow') console.log((await hosted.send(email)).id);
}
