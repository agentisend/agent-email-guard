import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApprovalRequired, createGuard, GuardRefused, policyToConfig, validatePolicy } from 'agent-email-guard';
import { loadPolicy } from 'agent-email-guard/policy';
import { nodemailerGuard } from 'agent-email-guard/nodemailer';
import { emailInputGuardrail } from 'agent-email-guard/openai-agents';
import { main } from '../src/cli.js';

const policy = {
  $schema: 'https://example.test/schema.json',
  version: 1,
  key: 'support-agent',
  budgets: { per_hour: 2 },
  rate: { per_minute: 10 },
  loop: { mode: 'repetition_only', max_identical_sends: 3 },
  approval: { recipients: ['@bigcustomer.com'] },
  suppress: ['@competitor.example'],
};

describe('policy file (agent-email-guard.json)', () => {
  it('maps snake_case keys to the config', () => {
    expect(policyToConfig(policy)).toMatchObject({
      key: 'support-agent',
      budgets: { perHour: 2 },
      rate: { perMinute: 10 },
      loop: { mode: 'repetition_only', maxIdenticalSends: 3 },
      approval: { recipients: ['@bigcustomer.com'] },
      suppress: ['@competitor.example'],
    });
  });

  it('names every problem', () => {
    expect(validatePolicy({ budgets: { per_hour: -1, perDay: 3 }, loop: { mode: 'loose' }, extra: 1 })).toEqual([
      '"budgets.per_hour" has the wrong type.',
      'Unknown key "budgets.perDay".',
      '"loop.mode" has the wrong type.',
      'Unknown key "extra".',
    ]);
    expect(() => policyToConfig([])).toThrow(/must be a JSON object/);
  });

  it('loads from disk and drives a guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aeg-'));
    const path = join(dir, 'agent-email-guard.json');
    writeFileSync(path, JSON.stringify(policy));
    const guard = createGuard(loadPolicy(path));
    expect((await guard.check({ to: 'a@competitor.example' })).reason).toBe('recipient_suppressed');
    expect(() => loadPolicy(join(dir, 'missing.json'))).toThrow(/No policy file/);
  });
});

describe('nodemailer plugin', () => {
  it('fails sendMail on a refusal or hold and sends the rest', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    transporter.use('compile', nodemailerGuard(policyToConfig(policy)));
    const ok = await transporter.sendMail({ from: 'a@yourapp.com', to: 'x@example.com', subject: 'Hi', text: 'one' });
    expect(JSON.parse(String(ok.message)).subject).toBe('Hi');
    await expect(transporter.sendMail({ from: 'a@yourapp.com', to: 's@competitor.example', subject: 'Hi', text: 'x' })).rejects.toBeInstanceOf(GuardRefused);
    await expect(transporter.sendMail({ from: 'a@yourapp.com', to: 'cto@bigcustomer.com', subject: 'Hi', text: 'x' })).rejects.toBeInstanceOf(ApprovalRequired);
    const approved = await transporter.sendMail({ from: 'a@yourapp.com', to: 'cto@bigcustomer.com', subject: 'Hi', text: 'x', guardApproved: true } as SendMailOptions);
    expect(approved.messageId).toBeTruthy();
    // Budget of 2 per hour is now spent.
    await expect(transporter.sendMail({ from: 'a@yourapp.com', to: 'y@example.com', subject: 'Hi', text: 'three' })).rejects.toMatchObject({ reason: 'agent_budget_exceeded' });
  });
});

describe('OpenAI Agents SDK tool input guardrail', () => {
  it('type-checks as an inputGuardrail and rejects with the reason', async () => {
    const guard = createGuard({ suppress: ['@competitor.example'] });
    const guardrail = emailInputGuardrail(guard);
    const sendEmail = tool({
      name: 'send_email',
      description: 'Send one email.',
      parameters: z.object({ to: z.string(), subject: z.string(), text: z.string() }),
      execute: async () => 'sent',
      inputGuardrails: [guardrail],
    });
    expect(sendEmail.name).toBe('send_email');
    const refused = await guardrail.run({ toolCall: { arguments: JSON.stringify({ to: 'x@competitor.example', subject: 'Hi', text: 'x' }) } });
    expect(refused.behavior).toEqual({ type: 'rejectContent', message: expect.stringMatching(/^refuse \(recipient_suppressed\): x@competitor\.example is on the suppression list/) });
    const allowed = await guardrail.run({ toolCall: { arguments: JSON.stringify({ to: 'ana@example.com', subject: 'Hi', text: 'x' }) } });
    expect(allowed.behavior).toEqual({ type: 'allow' });
  });
});

describe('CLI', () => {
  it('validate and check exit with the decision code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aeg-cli-'));
    const p = join(dir, 'agent-email-guard.json');
    const s = join(dir, 'send.json');
    writeFileSync(p, JSON.stringify(policy));
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => (writes.push(c), true);
    try {
      expect(await main(['validate', p])).toBe(0);
      writeFileSync(s, JSON.stringify({ to: 'cto@bigcustomer.com', subject: 'Hi' }));
      expect(await main(['check', '--policy', p, s])).toBe(2);
      writeFileSync(s, JSON.stringify({ to: 'a@competitor.example' }));
      expect(await main(['check', '--policy', p, s])).toBe(3);
      writeFileSync(s, JSON.stringify({ to: 'ana@example.com' }));
      expect(await main(['check', '--policy', p, s])).toBe(0);
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join('')).toContain('"reason": "recipient_requires_approval"');
  });
});
