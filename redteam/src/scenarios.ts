import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Bounds, ReferenceRun, Scenario, ScriptOp, UntrustedInput } from './types.js';

export interface BenchmarkManifest {
  readonly id: string;
  readonly version: number;
  readonly published: string;
  readonly headlineScenarioId: string;
  readonly headline: string;
  readonly referencePolicy: string;
  readonly metrics: readonly string[];
  readonly scenarioIds: readonly string[];
}

export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function loadBenchmark(root = packageRoot()): BenchmarkManifest {
  return parseBenchmark(readJson(join(root, 'benchmark', 'monthly.json')));
}

export function loadScenarios(root = packageRoot()): { benchmark: BenchmarkManifest; scenarios: Scenario[] } {
  const benchmark = loadBenchmark(root);
  const dir = join(root, 'scenarios');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const byId = new Map<string, Scenario>();
  for (const file of files) {
    const scenario = parseScenario(readJson(join(dir, file)));
    if (byId.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}.`);
    if (`${scenario.id}.json` !== file) throw new Error(`${file} must be named ${scenario.id}.json.`);
    byId.set(scenario.id, scenario);
  }
  const scenarios: Scenario[] = [];
  for (const id of benchmark.scenarioIds) {
    const scenario = byId.get(id);
    if (!scenario) throw new Error(`benchmark lists ${id} but scenarios/${id}.json is missing.`);
    scenarios.push(scenario);
    byId.delete(id);
  }
  if (byId.size > 0) {
    throw new Error(`Scenario files are not in the monthly benchmark: ${[...byId.keys()].join(', ')}.`);
  }
  const headlines = scenarios.filter((scenario) => scenario.headline);
  if (headlines.length !== 1 || headlines[0]?.id !== benchmark.headlineScenarioId) {
    throw new Error(`The monthly headline must be ${benchmark.headlineScenarioId}.`);
  }
  return { benchmark, scenarios };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parseBenchmark(value: unknown): BenchmarkManifest {
  const record = object(value, 'benchmark');
  const scenarioIds = stringArray(record.scenarioIds, 'scenarioIds');
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error('Duplicate benchmark scenario id.');
  return {
    id: stringField(record, 'id'),
    version: intField(record, 'version'),
    published: stringField(record, 'published'),
    headlineScenarioId: stringField(record, 'headlineScenarioId'),
    headline: stringField(record, 'headline'),
    referencePolicy: stringField(record, 'referencePolicy'),
    metrics: stringArray(record.metrics, 'metrics'),
    scenarioIds,
  };
}

function parseScenario(value: unknown): Scenario {
  const record = object(value, 'scenario');
  requireExactKeys(record, [
    'schemaVersion',
    'id',
    'name',
    'headline',
    'control',
    'untrusted',
    'task',
    'safe',
    'failure',
    'fixtures',
    'transport',
    'script',
    'expect',
    'reference',
  ]);
  if (record.schemaVersion !== 1) throw new Error('schemaVersion must be 1.');
  const fixtures = object(record.fixtures, 'fixtures');
  const transport = object(record.transport, 'transport');
  const expect = object(record.expect, 'expect');
  const reference = object(record.reference, 'reference');
  const script = parseScript(record.script);
  return {
    schemaVersion: 1,
    id: stringField(record, 'id'),
    name: stringField(record, 'name'),
    headline: booleanField(record, 'headline'),
    control: booleanField(record, 'control'),
    untrusted: parseUntrusted(record.untrusted),
    task: stringField(record, 'task'),
    safe: stringField(record, 'safe'),
    failure: stringField(record, 'failure'),
    fixtures: { contacts: stringArray(fixtures.contacts, 'contacts') },
    transport: { ambiguousError: booleanField(transport, 'ambiguousError') },
    script,
    expect: {
      withGuard: parseBounds(expect.withGuard, 'withGuard'),
      withoutGuard: parseBounds(expect.withoutGuard, 'withoutGuard'),
    },
    reference: {
      withGuard: parseReference(reference.withGuard, 'reference.withGuard'),
      withoutGuard: parseReference(reference.withoutGuard, 'reference.withoutGuard'),
    },
  };
}

function parseUntrusted(value: unknown): UntrustedInput {
  const record = object(value, 'untrusted');
  const channel = stringField(record, 'channel');
  if (channel !== 'none' && channel !== 'email' && channel !== 'web' && channel !== 'tool') {
    throw new Error(`Unknown untrusted channel ${channel}.`);
  }
  return { channel, content: stringField(record, 'content') };
}

function parseBounds(value: unknown, label: string): Bounds {
  const record = object(value, label);
  const bounds: { minThrough?: number; maxThrough?: number; limitsChanged?: boolean } = {};
  if ('minThrough' in record) bounds.minThrough = intField(record, 'minThrough');
  if ('maxThrough' in record) bounds.maxThrough = intField(record, 'maxThrough');
  if ('limitsChanged' in record) bounds.limitsChanged = booleanField(record, 'limitsChanged');
  return bounds;
}

function parseReference(value: unknown, label: string): ReferenceRun {
  const record = object(value, label);
  const run: ReferenceRun = {
    attempted: intField(record, 'attempted'),
    through: intField(record, 'through'),
    reason: stringField(record, 'reason'),
    detail: record.detail === null ? null : stringField(record, 'detail'),
  };
  if ('limitsChanged' in record) return { ...run, limitsChanged: booleanField(record, 'limitsChanged') };
  return run;
}

function parseScript(value: unknown): ScriptOp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('script must be a non-empty array.');
  return value.map((entry) => parseOp(entry));
}

function parseOp(value: unknown): ScriptOp {
  const record = object(value, 'script op');
  const op = stringField(record, 'op');
  if (op === 'send') {
    if ('vary' in record && record.vary !== 'index') throw new Error('vary must be "index".');
    const repeat = 'repeat' in record ? intField(record, 'repeat') : undefined;
    const retryOnProviderError = 'retryOnProviderError' in record ? intField(record, 'retryOnProviderError') : undefined;
    const vary = record.vary === 'index' ? 'index' : undefined;
    const step: Extract<ScriptOp, { op: 'send' }> = {
      op: 'send',
      message: parseMessage(record.message),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(retryOnProviderError !== undefined ? { retryOnProviderError } : {}),
      ...(vary !== undefined ? { vary } : {}),
    };
    return step;
  }
  if (op === 'emailEachContact') {
    const message = object(record.message, 'message');
    return {
      op: 'emailEachContact',
      message: {
        subject: stringField(message, 'subject'),
        text: optionalString(message, 'text'),
        html: optionalString(message, 'html'),
      },
    };
  }
  if (op === 'raiseLimits') {
    return {
      op: 'raiseLimits',
      perHour: optionalInt(record, 'perHour'),
      perMinute: optionalInt(record, 'perMinute'),
      maxIdentical: optionalInt(record, 'maxIdentical'),
    };
  }
  if (op === 'replyAllStorm') {
    return {
      op: 'replyAllStorm',
      rounds: intField(record, 'rounds'),
      a: stringField(record, 'a'),
      b: stringField(record, 'b'),
      subject: stringField(record, 'subject'),
      text: stringField(record, 'text'),
    };
  }
  throw new Error(`Unknown script op ${op}.`);
}

function parseMessage(value: unknown): { to: string[]; cc?: string[]; subject: string; text?: string; html?: string } {
  const record = object(value, 'message');
  const message: { to: string[]; cc?: string[]; subject: string; text?: string; html?: string } = {
    to: stringArray(record.to, 'to'),
    subject: stringField(record, 'subject'),
  };
  if ('cc' in record) message.cc = stringArray(record.cc, 'cc');
  const text = optionalString(record, 'text');
  const html = optionalString(record, 'html');
  if (text !== undefined) message.text = text;
  if (html !== undefined) message.html = html;
  return message;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join() !== expected.join()) {
    throw new Error(`Unexpected scenario keys: ${actual.join(', ')}.`);
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}

function intField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

function optionalInt(record: Record<string, unknown>, key: string): number | undefined {
  if (!(key in record)) return undefined;
  return intField(record, key);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  return stringField(record, key);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}
