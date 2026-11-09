import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePolicy } from '../src/index.js';
import { VECTOR_DIR } from './helpers.js';

const file = JSON.parse(readFileSync(join(VECTOR_DIR, 'policy', 'validation.json'), 'utf8')) as {
  cases: Array<{ name: string; policy: unknown; expect: { problems: string[] } }>;
};

describe('spec/vectors/policy/validation.json', () => {
  for (const c of file.cases) {
    it(c.name, () => expect(validatePolicy(c.policy)).toEqual(c.expect.problems));
  }
});
