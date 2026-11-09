/**
 * The hosted adapter (SPEC §8): the same decisions, enforced by the
 * AgentiSend API instead of this process.
 *
 * The local guard is advisory: it runs in the agent's process, so code the
 * agent controls can remove it. Here the limits live on the API key, the API
 * applies them to every request from every process, and the agent cannot
 * raise its own budget, resume its own kill switch or approve its own hold.
 *
 * Every endpoint below exists in the AgentiSend API today:
 *   POST  /emails/preflight           check()   — every send gate, nothing sent
 *   POST  /emails                     send()
 *   POST  /limits/keys/:id/kill       killSwitch.pause()
 *   GET   /limits/keys/:id            limits()
 *   PATCH /limits/keys/:id            setLimits() — a key may only lower its own
 *   GET   /agent-actions?state=pending  approvals.list()
 */

import { decision, type Decision, type DecisionEvidence } from './decisions.js';
import { ApprovalRequired, GuardRefused } from './errors.js';

export interface HostedGuardOptions {
  /** An AgentiSend API key. Default: process.env.AGENTISEND_API_KEY. */
  readonly apiKey?: string;
  /** The id of that key, for the kill switch and limits calls. */
  readonly keyId?: string;
  /** Default: process.env.AGENTISEND_BASE_URL, then https://api.agentisend.com. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** The email body POST /emails takes (Resend-compatible). */
export interface HostedEmail {
  readonly from: string;
  readonly to: string | readonly string[];
  readonly cc?: string | readonly string[];
  readonly bcc?: string | readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly [field: string]: unknown;
}

export interface HostedLimits {
  readonly api_key_id: string;
  readonly budget_per_period: number | null;
  readonly period: 'hourly' | 'daily' | 'monthly';
  readonly consumed_in_period: number;
  readonly rate_ceiling_per_minute: number | null;
  readonly paused: boolean;
  readonly paused_reason: string | null;
  readonly [field: string]: unknown;
}

/** An API answer that is not a guard decision (bad from address, unverified domain, …). */
export class AgentiSendApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string | null;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, fix: string | null, body: unknown) {
    super(message);
    this.name = 'AgentiSendApiError';
    this.status = status;
    this.code = code;
    this.fix = fix;
    this.body = body;
  }
}

interface ApiErrorShape {
  code?: string;
  message?: string;
  fix?: string;
  action_id?: string;
  retry_after_seconds?: number;
}

const CODE_TO_DECISION: Record<string, { outcome: Decision['outcome']; reason: Decision['reason'] }> = {
  kill_switch_active: { outcome: 'refuse', reason: 'kill_switch_active' },
  agent_budget_exceeded: { outcome: 'refuse', reason: 'agent_budget_exceeded' },
  rate_ceiling_exceeded: { outcome: 'refuse', reason: 'rate_ceiling_exceeded' },
  approval_required: { outcome: 'hold_for_approval', reason: 'recipient_requires_approval' },
  suppressed_recipient: { outcome: 'refuse', reason: 'recipient_suppressed' },
};

/** Map an API error to a guard decision, or null when it is not one. */
export function decisionFromApiError(err: ApiErrorShape): Decision | null {
  const mapped = err.code ? CODE_TO_DECISION[err.code] : undefined;
  if (!mapped) return null;
  const evidence: DecisionEvidence = { code: err.code ?? null, fix: err.fix ?? null };
  if (err.action_id !== undefined) evidence.action_id = err.action_id;
  if (err.retry_after_seconds !== undefined) evidence.retry_after_seconds = err.retry_after_seconds;
  const message = (err.message ?? '').trim();
  return decision(mapped.outcome, mapped.reason, message.endsWith('.') ? message : `${message}.`, evidence);
}

export interface HostedGuard {
  /** Runs every send gate on the API without sending. */
  check(email: HostedEmail): Promise<Decision>;
  /** Sends through the API; throws GuardRefused / ApprovalRequired with the API's decision. */
  send(email: HostedEmail, options?: { idempotencyKey?: string }): Promise<{ id: string; [field: string]: unknown }>;
  limits(): Promise<HostedLimits>;
  /** Lower this key's limits. Raising one is a person's decision, made in the console. */
  setLimits(limits: { budget?: number | null; period?: 'hourly' | 'daily' | 'monthly'; perMinute?: number | null }): Promise<HostedLimits>;
  readonly killSwitch: {
    /** Stops this key on the API, for every process using it. */
    pause(reason?: string): Promise<HostedLimits>;
    /** Always throws: only a person signed in to the console can resume a key. */
    resume(): Promise<never>;
  };
  readonly approvals: {
    /** Held sends waiting for a person. Approving and rejecting happen in the console. */
    list(): Promise<Array<Record<string, unknown>>>;
  };
}

export function createHostedGuard(options: HostedGuardOptions = {}): HostedGuard {
  const env = typeof process !== 'undefined' ? process.env : {};
  const apiKey = options.apiKey ?? env.AGENTISEND_API_KEY;
  if (!apiKey) throw new TypeError('createHostedGuard needs an API key: pass apiKey or set AGENTISEND_API_KEY.');
  const baseUrl = (options.baseUrl ?? env.AGENTISEND_BASE_URL ?? 'https://api.agentisend.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = { message: text };
    }
    return { status: res.status, json };
  }

  function apiError(status: number, json: unknown): ApiErrorShape {
    const o = (json ?? {}) as { error?: ApiErrorShape; message?: string; name?: string };
    if (o.error && typeof o.error === 'object') return o.error;
    return { code: o.name ?? `http_${status}`, message: o.message ?? `The API answered ${status}.` };
  }

  function needKeyId(): string {
    if (!options.keyId) throw new TypeError('This call needs keyId: the id of the API key (GET /api-keys lists them).');
    return options.keyId;
  }

  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, json } = await call(method, path, body);
    if (status >= 400) {
      const e = apiError(status, json);
      throw new AgentiSendApiError(status, e.code ?? `http_${status}`, e.message ?? '', e.fix ?? null, json);
    }
    return json as T;
  }

  return {
    async check(email) {
      const { status, json } = await call('POST', '/emails/preflight', email);
      if (status >= 400) {
        const e = apiError(status, json);
        const d = decisionFromApiError(e);
        if (d) return d;
        throw new AgentiSendApiError(status, e.code ?? `http_${status}`, e.message ?? '', e.fix ?? null, json);
      }
      const report = json as { ok: boolean; error: ApiErrorShape | null; simulated?: boolean };
      if (report.ok) return decision('allow', 'ok', 'Every send gate on the API passed; nothing was sent.', { simulated: report.simulated ?? false });
      const d = report.error ? decisionFromApiError(report.error) : null;
      if (d) return d;
      const e = report.error ?? {};
      throw new AgentiSendApiError(422, e.code ?? 'preflight_failed', e.message ?? 'Preflight failed.', e.fix ?? null, json);
    },

    async send(email, sendOptions = {}) {
      const { status, json } = await call(
        'POST',
        '/emails',
        email,
        sendOptions.idempotencyKey ? { 'idempotency-key': sendOptions.idempotencyKey } : {},
      );
      if (status < 400) return json as { id: string };
      const e = apiError(status, json);
      const d = decisionFromApiError(e);
      if (d?.outcome === 'refuse') throw new GuardRefused(d);
      if (d?.outcome === 'hold_for_approval') {
        throw new ApprovalRequired(d, () =>
          Promise.reject(new TypeError('A held AgentiSend send is approved by a person in the console (Agents → Approvals); approving it sends it.')),
        );
      }
      throw new AgentiSendApiError(status, e.code ?? `http_${status}`, e.message ?? '', e.fix ?? null, json);
    },

    limits: async () => ok<HostedLimits>('GET', `/limits/keys/${needKeyId()}`),

    async setLimits(l) {
      const body: Record<string, unknown> = {};
      if (l.budget !== undefined) body.budget_per_period = l.budget;
      if (l.period !== undefined) body.period = l.period;
      if (l.perMinute !== undefined) body.rate_ceiling_per_minute = l.perMinute;
      return ok<HostedLimits>('PATCH', `/limits/keys/${needKeyId()}`, body);
    },

    killSwitch: {
      pause: async (reason) => ok<HostedLimits>('POST', `/limits/keys/${needKeyId()}/kill`, reason ? { reason } : {}),
      resume: () =>
        Promise.reject(
          new TypeError('An API key cannot resume itself. A person signed in to the AgentiSend console resumes it under Agents.'),
        ),
    },

    approvals: {
      async list() {
        const page = await ok<{ data?: Array<Record<string, unknown>> }>('GET', '/agent-actions?state=pending');
        return page.data ?? [];
      },
    },
  };
}
