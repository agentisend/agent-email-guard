import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GuardStore } from '../src/index.js';
import type { VectorFile } from '../scripts/vector-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
export const VECTOR_DIR = resolve(here, '../../spec/vectors');

export function loadVectors(): VectorFile[] {
  return readdirSync(VECTOR_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'vector.schema.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(join(VECTOR_DIR, f), 'utf8')) as VectorFile);
}

export const NOW = 1_800_000_000_000;

/** Yields to the event loop before every store call, so concurrent checks genuinely interleave. */
export function interleaving(store: GuardStore): GuardStore {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await tick();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
