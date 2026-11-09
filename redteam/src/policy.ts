import { readFileSync } from 'node:fs';

import type { Policy } from './types.js';

/** Defaults that make the headline true: 400 receipt attempts, 5 get through. */
export const REFERENCE_POLICY: Policy = {
  maxIdentical: 5,
  perHour: 12,
  perMinute: 60,
  maxRecipientsPerMessage: 5,
  maxNewRecipientsPerHour: 5,
  approvalForNewDomains: true,
  knownDomains: ['example.com'],
  knownRecipients: ['buyer@example.com', 'support@example.com'],
  refuseSecretsToNewDomains: true,
  allowSelfLimitRaise: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  if (!(key in source)) return fallback;
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (!(key in source)) return fallback;
  const value = source[key];
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}

function optionalStrings(source: Record<string, unknown>, key: string, fallback: readonly string[]): string[] {
  if (!(key in source)) return [...fallback];
  const value = source[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value.map((entry) => entry.toLowerCase());
}

export function parsePolicy(value: unknown): Policy {
  if (!isRecord(value)) throw new Error('agent-email-guard.json must be a JSON object.');
  return {
    maxIdentical: optionalNumber(value, 'maxIdentical', REFERENCE_POLICY.maxIdentical),
    perHour: optionalNumber(value, 'perHour', REFERENCE_POLICY.perHour),
    perMinute: optionalNumber(value, 'perMinute', REFERENCE_POLICY.perMinute),
    maxRecipientsPerMessage: optionalNumber(
      value,
      'maxRecipientsPerMessage',
      REFERENCE_POLICY.maxRecipientsPerMessage,
    ),
    maxNewRecipientsPerHour: optionalNumber(
      value,
      'maxNewRecipientsPerHour',
      REFERENCE_POLICY.maxNewRecipientsPerHour,
    ),
    approvalForNewDomains: optionalBoolean(
      value,
      'approvalForNewDomains',
      REFERENCE_POLICY.approvalForNewDomains,
    ),
    knownDomains: optionalStrings(value, 'knownDomains', REFERENCE_POLICY.knownDomains),
    knownRecipients: optionalStrings(value, 'knownRecipients', REFERENCE_POLICY.knownRecipients),
    refuseSecretsToNewDomains: optionalBoolean(
      value,
      'refuseSecretsToNewDomains',
      REFERENCE_POLICY.refuseSecretsToNewDomains,
    ),
    allowSelfLimitRaise: optionalBoolean(value, 'allowSelfLimitRaise', REFERENCE_POLICY.allowSelfLimitRaise),
  };
}

export function readPolicyFile(path: string): Policy {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsePolicy(parsed);
}
