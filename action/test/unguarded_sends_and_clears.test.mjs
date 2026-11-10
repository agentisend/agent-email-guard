import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../lib/scan.js';
import { run } from '../lib/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join(root, 'fixtures', name);

function rules(dir, scope = 'agent') {
  return scanRepo(fixture(dir), { scope }).map((finding) => `${finding.file}:${finding.line}:${finding.rule}`);
}

test('an agent file that calls resend.emails.send is reported', () => {
  const hits = rules('agent-resend');
  assert.deepEqual(hits, ['agent.ts:5:resend.emails.send']);
});

test('require of ai is agent code', () => {
  assert.deepEqual(rules('require-ai'), ['agent.js:5:resend.emails.send']);
});

test('a policy file clears every send it covers, including scope all', () => {
  assert.deepEqual(rules('agent-resend-policy'), []);
  assert.deepEqual(rules('plain-with-policy', 'all'), []);
  assert.deepEqual(rules('mcp-with-policy'), []);
});

test('a guard import clears that file and not its sibling', () => {
  assert.deepEqual(rules('agent-resend-import'), []);
  assert.deepEqual(rules('python-guard'), []);
  assert.deepEqual(rules('php-guard'), []);
  assert.deepEqual(rules('guard-sibling'), ['b.ts:5:resend.emails.send']);
});

test('a type-only import does not mark agent code and does not count as the guard', () => {
  assert.deepEqual(rules('type-only-agent'), []);
  assert.deepEqual(rules('type-only-agent', 'all'), ['agent.ts:7:resend.emails.send']);
  assert.deepEqual(rules('type-only-guard'), ['agent.ts:9:resend.emails.send']);
});

test('scope agent skips a send outside agent code and scope all reports it', () => {
  assert.deepEqual(rules('plain-resend'), []);
  assert.deepEqual(rules('plain-resend', 'all'), ['app.ts:2:resend.emails.send']);
});

test('a nested policy covers its directory only', () => {
  assert.deepEqual(rules('nested-policy'), ['apps/other/agent.ts:5:resend.emails.send']);
});

test('nodemailer, SES, SendGrid, Mailgun, Postmark, and AgentiSend calls are reported', () => {
  assert.deepEqual(rules('nodemailer-langchain'), [
    'agent.ts:6:nodemailer.createTransport',
    'agent.ts:7:nodemailer.sendMail',
  ]);
  assert.deepEqual(rules('create-transport-only'), ['agent.ts:6:nodemailer.createTransport']);
  assert.deepEqual(rules('ses-openai'), ['agent.ts:5:ses.SendEmail', 'agent.ts:6:ses.SendRawEmail']);
  assert.deepEqual(rules('sendgrid-mastra'), ['agent.ts:5:sendgrid.sgMail.send']);
  assert.deepEqual(rules('sendgrid-renamed'), ['agent.ts:6:sendgrid.send']);
  assert.deepEqual(rules('mailgun-crew'), ['send.py:6:mailgun.messages.create']);
  assert.deepEqual(rules('postmark-mcp'), ['agent.ts:5:postmark.sendEmail']);
  assert.deepEqual(rules('agentisend-ai'), ['agent.ts:5:agentisend.emails.send']);
  assert.deepEqual(rules('ses-python'), ['send.py:5:ses.send_email']);
  assert.deepEqual(rules('python-resend'), ['send.py:5:resend.emails.send']);
  assert.deepEqual(rules('go-ses'), ['main.go:7:ses.SendEmail']);
  assert.deepEqual(rules('php-resend'), ['send.php:6:resend.emails.send']);
});

test('comments, strings, stripe messages.create, channel.send, and the word session are not sends', () => {
  assert.deepEqual(rules('comment-and-string'), []);
  assert.deepEqual(rules('comment-and-string', 'all'), []);
  assert.deepEqual(rules('mailgun-mentioned-in-string'), []);
  assert.deepEqual(rules('stripe-not-mailgun'), []);
  assert.deepEqual(rules('channel-send'), []);
  assert.deepEqual(rules('session-word'), []);
});

test('the reported line is the call, not a string that mentions one', () => {
  const hits = scanRepo(fixture('line-number'));
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.equal(hit.file, 'agent.ts');
  assert.equal(hit.line, 6);
  assert.equal(hit.column, 10);
  const [templated] = scanRepo(fixture('template-expr'));
  assert.equal(templated.line, 5);
  assert.equal(templated.rule, 'resend.emails.send');
});

test('email MCP configs are reported and unrelated MCP configs are not', () => {
  assert.deepEqual(rules('mcp-resend'), ['.cursor/mcp.json:3:mcp.email']);
  assert.deepEqual(rules('mcp-jsonc'), ['mcp.json:4:mcp.email']);
  assert.deepEqual(rules('mcp-filesystem'), []);
  assert.deepEqual(rules('mcp-session'), []);
  assert.deepEqual(rules('mcp-invalid'), []);
  assert.deepEqual(rules('mcp-named-email'), ['mcp.json:3:mcp.email']);
  assert.deepEqual(rules('mcp-path-email'), []);
});

test('the action warns by default and exits 1 only when fail is true', () => {
  const warned = [];
  const code = run(
    { GITHUB_WORKSPACE: root, INPUT_PATH: 'fixtures/agent-resend', INPUT_SCOPE: 'agent', INPUT_FAIL: 'false' },
    (chunk) => warned.push(chunk),
    () => {},
  );
  assert.equal(code, 0);
  assert.match(warned.join(''), /::warning file=fixtures\/agent-resend\/agent\.ts,line=5,col=\d+,title=agent-email-guard::/);
  assert.match(warned.join(''), /1 unguarded email send/);
  assert.match(warned.join(''), /Set fail to true/);

  const failed = [];
  const failCode = run(
    { GITHUB_WORKSPACE: root, INPUT_PATH: 'fixtures/agent-resend', INPUT_FAIL: 'true' },
    (chunk) => failed.push(chunk),
    () => {},
  );
  assert.equal(failCode, 1);
  assert.match(failed.join(''), /::error file=fixtures\/agent-resend\/agent\.ts/);

  const clean = [];
  const cleanCode = run(
    { GITHUB_WORKSPACE: root, INPUT_PATH: 'fixtures/agent-resend-policy' },
    (chunk) => clean.push(chunk),
    () => {},
  );
  assert.equal(cleanCode, 0);
  assert.equal(clean.join(''), 'agent-email-guard: no unguarded email send.\n');

  const errors = [];
  assert.equal(run({ INPUT_SCOPE: 'repo' }, () => {}, (chunk) => errors.push(chunk)), 1);
  assert.match(errors.join(''), /scope must be "agent" or "all"/);
});

test('node lib/index.js is the action entry and does not call the network', () => {
  const js = ['index.js', 'scan.js', 'mask.js', 'modules.js']
    .map((name) => readFileSync(join(root, 'lib', name), 'utf8'))
    .join('\n');
  for (const banned of ['node:http', 'node:https', 'node:net', 'node:dns', 'fetch(', 'http.request', 'https.request', 'child_process', 'XMLHttpRequest']) {
    assert.equal(js.includes(banned), false, banned);
  }

  const res = spawnSync(process.execPath, ['lib/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_WORKSPACE: root,
      INPUT_PATH: 'fixtures/plain-resend',
      INPUT_SCOPE: 'all',
      INPUT_FAIL: 'true',
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error file=fixtures\/plain-resend\/app\.ts,line=2/);
});
