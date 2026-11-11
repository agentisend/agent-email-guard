import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(root, '..', '..', '..');

test('the README badge and the six-line workflow match the example file', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /badge\.svg/);
  assert.match(readme, /agent-email-guard\.yml\/badge\.svg/);
  const fence = readme.match(/```yaml\n([\s\S]*?)```/);
  assert.ok(fence);
  const snippet = fence[1].replace(/\n$/, '');
  const lines = snippet.split('\n');
  assert.equal(lines.length, 6);
  const example = readFileSync(join(root, 'examples', 'agent-email-guard.yml'), 'utf8').replace(/\n$/, '');
  assert.equal(snippet, example);
  assert.match(snippet, /uses: agentisend\/agent-email-guard-action@v1/);
  assert.match(readme, /fail: true/);
});

test('lib matches tsc when the monorepo compiler is installed', () => {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) return;
  const out = mkdtempSync(join(tmpdir(), 'agent-email-guard-action-'));
  try {
    execFileSync(tsc, ['-p', join(root, 'tsconfig.build.json'), '--outDir', out, '--rootDir', join(root, 'src')], {
      stdio: 'inherit',
    });
    for (const name of ['index.js', 'scan.js', 'mask.js', 'modules.js']) {
      assert.equal(readFileSync(join(out, name), 'utf8'), readFileSync(join(root, 'lib', name), 'utf8'), name);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
