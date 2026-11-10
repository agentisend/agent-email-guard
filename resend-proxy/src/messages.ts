/**
 * Resend's wire shape for one email, mapped onto a GuardSend.
 * The proxy never rewrites the bytes it forwards; this module only reads them.
 */

import type { GuardSend } from 'agent-email-guard';

export class RequestShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestShapeError';
  }
}

function addressField(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** One object on POST /emails, or one element of POST /emails/batch. */
export function toGuardSend(value: unknown): GuardSend {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestShapeError('Each email must be a JSON object.');
  }
  const email = value as Record<string, unknown>;
  const to = addressField(email.to);
  if (to === undefined) throw new RequestShapeError('Missing `to` field.');
  const send: { -readonly [K in keyof GuardSend]: GuardSend[K] } = { to };
  const from = textField(email.from);
  const cc = addressField(email.cc);
  const bcc = addressField(email.bcc);
  const subject = textField(email.subject);
  const text = textField(email.text);
  const html = textField(email.html);
  if (from !== undefined) send.from = from;
  if (cc !== undefined) send.cc = cc;
  if (bcc !== undefined) send.bcc = bcc;
  if (subject !== undefined) send.subject = subject;
  if (text !== undefined) send.text = text;
  if (html !== undefined) send.html = html;
  return send;
}

/** The messages a guarded route carries. The original bytes stay untouched. */
export function messagesFrom(kind: 'single' | 'batch', raw: Buffer): GuardSend[] {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new RequestShapeError('The body is not valid JSON.');
  }
  if (kind === 'single') return [toGuardSend(json)];
  if (!Array.isArray(json)) throw new RequestShapeError('The batch body must be a JSON array.');
  return json.map((item, index) => {
    try {
      return toGuardSend(item);
    } catch (err) {
      if (err instanceof RequestShapeError) throw new RequestShapeError(`Item ${index}: ${err.message}`);
      throw err;
    }
  });
}
