import { describe, expect, it } from 'vitest';
import { ApprovalRequired, GuardRefused } from '../src/index.js';
import { AgentiSendApiError, createHostedGuard } from '../src/agentisend.js';

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function stubFetch(routes: Record<string, (body: unknown) => { status: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, body });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ statusCode: 404, name: 'not_found', message: 'nope' }), { status: 404 });
    const r = route(body);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const email = { from: 'agent@yourapp.com', to: 'a@example.com', subject: 'Hi', text: 'x' };
const nested = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ({
  status,
  json: { statusCode: status, name: code, message, error: { code, message, fix: 'Do the fix.', ...extra } },
});

describe('hosted adapter: the AgentiSend API enforces the same decisions', () => {
  it('check() calls POST /emails/preflight with the key and maps ok to allow', async () => {
    const { calls, fetchImpl } = stubFetch({ 'POST /emails/preflight': () => ({ status: 200, json: { ok: true, simulated: false, error: null, checks: {} } }) });
    const g = createHostedGuard({ apiKey: 'as_test', fetch: fetchImpl, baseUrl: 'https://api.test' });
    const d = await g.check(email);
    expect(d).toMatchObject({ outcome: 'allow', reason: 'ok' });
    expect(calls[0]?.headers.authorization).toBe('Bearer as_test');
    expect(calls[0]?.body).toEqual(email);
  });

  it('a preflight report with approval_required becomes a hold', async () => {
    const { fetchImpl } = stubFetch({
      'POST /emails/preflight': () => ({ status: 200, json: { ok: false, simulated: false, error: { code: 'approval_required', message: 'This action requires human approval before it executes', fix: 'f' }, checks: {} } }),
    });
    const d = await createHostedGuard({ apiKey: 'k', fetch: fetchImpl }).check(email);
    expect(d.outcome).toBe('hold_for_approval');
    expect(d.reason).toBe('recipient_requires_approval');
    expect(d.message.endsWith('.')).toBe(true);
  });

  it('send() maps budget, ceiling and kill switch refusals to GuardRefused', async () => {
    for (const [status, code] of [[402, 'agent_budget_exceeded'], [429, 'rate_ceiling_exceeded'], [403, 'kill_switch_active']] as const) {
      const { fetchImpl } = stubFetch({ 'POST /emails': () => nested(status, code, 'Refused.') });
      const err = await createHostedGuard({ apiKey: 'k', fetch: fetchImpl }).send(email).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GuardRefused);
      expect((err as GuardRefused).reason).toBe(code);
      expect((err as GuardRefused).decision.evidence.fix).toBe('Do the fix.');
    }
  });

  it('a held send carries the action id, and approve() points to the console', async () => {
    const { fetchImpl } = stubFetch({ 'POST /emails': () => nested(403, 'approval_required', 'Held.', { action_id: '1d2c0c5e-0000-4000-8000-000000000000' }) });
    const err = (await createHostedGuard({ apiKey: 'k', fetch: fetchImpl }).send(email).catch((e: unknown) => e)) as ApprovalRequired;
    expect(err).toBeInstanceOf(ApprovalRequired);
    expect(err.decision.evidence.action_id).toBe('1d2c0c5e-0000-4000-8000-000000000000');
    await expect(err.approve()).rejects.toThrow(/console/);
  });

  it('other API errors are thrown as AgentiSendApiError, not decisions', async () => {
    const { fetchImpl } = stubFetch({ 'POST /emails': () => nested(422, 'domain_not_verified', 'Verify the domain first.') });
    const err = await createHostedGuard({ apiKey: 'k', fetch: fetchImpl }).send(email).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentiSendApiError);
    expect((err as AgentiSendApiError).code).toBe('domain_not_verified');
  });

  it('kill switch, limits and approvals use the real endpoints; resume is refused', async () => {
    const limits = { api_key_id: 'kid', budget_per_period: 100, period: 'daily', consumed_in_period: 3, rate_ceiling_per_minute: 10, paused: false, paused_reason: null };
    const { calls, fetchImpl } = stubFetch({
      'POST /limits/keys/kid/kill': (b) => ({ status: 200, json: { ...limits, paused: true, paused_reason: (b as { reason: string }).reason } }),
      'GET /limits/keys/kid': () => ({ status: 200, json: limits }),
      'PATCH /limits/keys/kid': (b) => ({ status: 200, json: { ...limits, ...(b as object) } }),
      'GET /agent-actions?state=pending': () => ({ status: 200, json: { object: 'list', data: [{ id: 'act_1' }], has_more: false, next_cursor: null } }),
    });
    const g = createHostedGuard({ apiKey: 'k', keyId: 'kid', fetch: fetchImpl });
    expect((await g.killSwitch.pause('looping')).paused_reason).toBe('looping');
    expect((await g.limits()).consumed_in_period).toBe(3);
    expect((await g.setLimits({ budget: 50, perMinute: 5 })).budget_per_period).toBe(50);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ budget_per_period: 50, rate_ceiling_per_minute: 5 });
    expect(await g.approvals.list()).toEqual([{ id: 'act_1' }]);
    await expect(g.killSwitch.resume()).rejects.toThrow(/cannot resume itself/);
  });

  it('needs an API key and, for key calls, a key id', async () => {
    const saved = process.env.AGENTISEND_API_KEY;
    delete process.env.AGENTISEND_API_KEY;
    expect(() => createHostedGuard()).toThrow(/API key/);
    process.env.AGENTISEND_API_KEY = saved;
    await expect(createHostedGuard({ apiKey: 'k' }).limits()).rejects.toThrow(/keyId/);
  });
});
