import type { GuardSend } from 'agent-email-guard';

const SEND_NAME = /send|email|mail/i;
const BATCH_KEYS = ['emails', 'messages', 'batch'] as const;

export interface ClassifiedSend {
  readonly kind: 'send';
  readonly messages: GuardSend[];
}

export interface ClassifiedPass {
  readonly kind: 'pass';
}

/**
 * Configured names win. With no list, a tool is a send when its name
 * matches send/email/mail and the arguments carry `to` plus a subject
 * or a body. Batch arguments expand to one Send per message.
 */
export function classifyCall(
  name: string,
  args: Record<string, unknown>,
  key: string,
  configured: ReadonlySet<string> | null,
): ClassifiedSend | ClassifiedPass {
  const listed = configured !== null && configured.size > 0;
  const selected = listed ? configured.has(name) : SEND_NAME.test(name);
  if (!selected) return { kind: 'pass' };

  const batch = extractBatch(args);
  if (batch) {
    if (!listed && batch.every((item) => !hasSendShape(item))) return { kind: 'pass' };
    return { kind: 'send', messages: batch.map((item) => mapMessage(item, key)) };
  }
  if (!listed && !hasSendShape(args)) return { kind: 'pass' };
  return { kind: 'send', messages: [mapMessage(args, key)] };
}

function extractBatch(args: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const key of BATCH_KEYS) {
    const value = args[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    if (value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      return value as Record<string, unknown>[];
    }
  }
  return null;
}

function hasSendShape(args: Record<string, unknown>): boolean {
  if (addressesOf(args['to']).length === 0) return false;
  const subject = typeof args['subject'] === 'string' && args['subject'].length > 0;
  const body = ['text', 'html', 'body', 'plain'].some((field) => {
    const value = args[field];
    return typeof value === 'string' && value.length > 0;
  });
  return subject || body;
}

export function mapMessage(args: Record<string, unknown>, key: string): GuardSend {
  return {
    key,
    to: addressesOf(args['to']),
    cc: addressesOf(args['cc']),
    bcc: addressesOf(args['bcc']),
    subject: firstString(args, ['subject']),
    text: firstString(args, ['text', 'body', 'plain']),
    html: firstString(args, ['html']),
  };
}

function firstString(args: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = args[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

function addressesOf(value: unknown): string[] {
  const out: string[] = [];
  const push = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const part of item.split(/[,;]/)) {
        const trimmed = part.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) push(child);
    }
  };
  push(value);
  return out;
}
