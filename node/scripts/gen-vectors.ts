/**
 * Generates spec/vectors/*.json by running every scenario through this
 * package and writing the observed decisions as the expectation.
 *
 *   pnpm vectors          rewrite the files
 *   pnpm vectors:check    fail when a file differs from a fresh run
 *
 * When this runs inside the AgentiSend monorepo, every loop step is also run
 * through the private reference implementation
 * (packages/agent-guard/src/loop-detection.ts) and the generator fails when
 * the two disagree on the outcome, the reason token or the match count.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCase, type VectorCase, type VectorFile, type VectorSend, type VectorStep, type ExpectedDecision } from './vector-runner.js';
import { addressList } from '../src/text.js';
import { validatePolicy } from '../src/policy.js';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = resolve(here, '../../spec/vectors');
const REFERENCE = resolve(here, '../../../../packages/agent-guard/src/loop-detection.ts');

const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------
// Traffic builders, ported from the reference tests.
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

type Timed = { at: number; send: VectorSend };
const records = (list: Timed[]): VectorStep[] => list.map(({ at, send }) => ({ op: 'record', at, send }));
const check = (at: number, send: VectorSend, extra: Partial<{ approved: boolean; note: string }> = {}): VectorStep => ({
  op: 'check',
  at,
  send,
  ...extra,
});
const sendStep = (at: number, send: VectorSend, note?: string): VectorStep => ({ op: 'send', at, send, ...(note ? { note } : {}) });

const FIRST = ['ana', 'belle', 'carlos', 'dee', 'elena', 'farid', 'gita', 'hugo', 'ines', 'jonas'];
const LAST = ['acme', 'bright', 'cedarline', 'deltaworks', 'everly', 'foxglove', 'granitetech'];
const TOPICS = ['invoice', 'receipt', 'welcome', 'password reset', 'weekly digest', 'shipping notice'];

function legitimateTraffic(count: number, seed: number): Timed[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => {
    const to = `${FIRST[Math.floor(rand() * FIRST.length)]}@${LAST[Math.floor(rand() * LAST.length)]}.com`;
    const subject = `Your ${TOPICS[Math.floor(rand() * TOPICS.length)]} (#${Math.floor(rand() * 100000)})`;
    const text = `Hello ${FIRST[Math.floor(rand() * FIRST.length)]}, here are the details you asked for regarding ${TOPICS[Math.floor(rand() * TOPICS.length)]}. Reference ${Math.floor(rand() * 1e9)}.`;
    return { at: NOW - (count - i) * 30_000, send: { to, subject, text } };
  });
}

function mutatedContentLoop(count: number): Timed[] {
  return Array.from({ length: count }, (_, i) => ({
    at: NOW - (count - i) * 5_000,
    send: {
      to: i % 2 === 0 ? 'target@example.com' : 'target2@example.com',
      subject: `Following up, note ${i} of my sequence`,
      text:
        `Message ${i}: ${'x'.repeat(3 + (i % 7))} quick thought on your ${['pricing', 'roadmap', 'team', 'growth'][i % 4]}` +
        ` plans; happy to share what we learned with teams like yours this ${['spring', 'summer', 'autumn', 'winter'][i % 4]}. Ref ${i * 7919}.`,
    },
  }));
}

function alertsTo(recipients: string[], count: number): Timed[] {
  return Array.from({ length: count }, (_, i) => ({
    at: NOW - (count - i) * MIN,
    send: {
      to: recipients,
      subject: `Alert ${i}: ${['disk', 'queue', 'latency', 'errors'][i % 4]} on host ${i * 13}`,
      text: `Check ${i} crossed its threshold at step ${i * 7919}; ${'z'.repeat(i % 9)} ${['north', 'south', 'east', 'west'][i % 4]} region.`,
    },
  }));
}

function collapsedOwner(count: number): Timed[] {
  return Array.from({ length: count }, (_, i) => ({
    at: NOW - (count - i) * MIN,
    send: {
      to: 'owner@example.com',
      subject: `Alert ${i} ${'abc'.repeat(i % 5)}`,
      text: `Reading ${i * 17} crossed ${'z'.repeat(i % 7)} in region ${i}.`,
    },
  }));
}

const ROADMAP: VectorSend = {
  to: 'victim@example.com',
  subject: 'Quick question about your roadmap',
  text: 'Hi, I wanted to follow up on my last note about your Q3 roadmap. Any interest?',
};
const identical = (count: number, at = NOW - count * 10): VectorStep => ({
  op: 'record',
  at,
  send: ROADMAP,
  repeat: count,
  every_ms: 10,
});

// ---------------------------------------------------------------------------
// The vector files.
// ---------------------------------------------------------------------------

const FILES: VectorFile[] = [
  {
    name: 'loop_repetition',
    description: 'The retry loop that sends one message thousands of times: refused from the fourth near-identical send to the same To line inside the window.',
    source: 'packages/agent-guard/test/loop-4000-repetition.test.ts',
    cases: [
      {
        name: '4000 identical sends, then the 4,001st',
        description: 'One recipient and identical content trip both signals; the token is loop_repetition_detected and the sentence names both.',
        config: {},
        steps: [identical(4000), check(NOW, ROADMAP)],
      },
      {
        name: 'a slightly reworded body still matches',
        config: {},
        steps: [identical(4000), check(NOW, { ...ROADMAP, text: 'Hi, I wanted to follow up on my last note about my Q3 roadmap. Any interest?' })],
      },
      {
        name: 'two prior sends: allowed',
        config: {},
        steps: [identical(2), check(NOW, ROADMAP)],
      },
      {
        name: 'three prior sends: refused',
        config: {},
        steps: [identical(3), check(NOW, ROADMAP)],
      },
      {
        name: 'sends older than the window do not count',
        config: {},
        steps: [{ op: 'record', at: NOW - 2 * HOUR, send: ROADMAP, repeat: 50, every_ms: 0 }, check(NOW, ROADMAP)],
      },
      {
        name: 'the To line is compared as a sorted set',
        description: 'B,A after A,B three times is the same recipient set.',
        config: {},
        steps: [
          { op: 'record', at: NOW - 3000, send: { ...ROADMAP, to: ['a@example.com', 'b@example.com'] }, repeat: 3, every_ms: 1000 },
          check(NOW, { ...ROADMAP, to: 'B@example.com, a@example.com' }),
        ],
      },
      {
        name: 'a custom window and threshold',
        config: { loop: { window_ms: 10 * MIN, max_identical_sends: 5 } },
        steps: [
          { op: 'record', at: NOW - 11 * MIN, send: ROADMAP, repeat: 5, every_ms: 0 },
          { op: 'record', at: NOW - 5 * MIN, send: ROADMAP, repeat: 4, every_ms: 1000 },
          check(NOW, ROADMAP, { note: 'four inside the 10-minute window: allowed' }),
          { op: 'record', at: NOW + 1000, send: ROADMAP },
          check(NOW + 2000, ROADMAP, { note: 'five inside: refused' }),
        ],
      },
    ],
  },
  {
    name: 'loop_diverse_traffic',
    description: 'False-positive guard: varied legitimate traffic is never flagged.',
    source: 'packages/agent-guard/test/diverse-traffic-not-flagged.test.ts',
    cases: [
      {
        name: '120 varied transactional sends',
        config: {},
        steps: [
          ...records(legitimateTraffic(120, 42)),
          check(NOW, {
            to: 'newcustomer@brightco.io',
            subject: 'Your invoice (#88213)',
            text: 'Hello ana, here are the details you asked for regarding invoice. Reference 554032987.',
          }),
        ],
      },
      {
        name: 'a 12-send sample is below the entropy floor',
        config: {},
        steps: [...records(legitimateTraffic(12, 7)), check(NOW, { to: 'one@of-the-three.com', subject: 's', text: 'b' })],
      },
      {
        name: 'repeat correspondence with individually written content',
        config: {},
        steps: [
          ...records(
            Array.from({ length: 150 }, (_, n) => {
              const round = Math.floor(n / 25);
              const c = n % 25;
              return {
                at: NOW - (150 - n) * 20_000,
                send: {
                  to: `customer${c}@theirco.com`,
                  subject: `Re: ticket ${c} update ${round}`,
                  text: `Round ${round} for ticket ${c}: we reproduced the issue on build ${round}${c} and shipped a fix candidate.`,
                },
              };
            }),
          ),
          check(NOW, { to: 'customer7@theirco.com', subject: 'Re: ticket 7 update 6', text: 'Round 6 for ticket 7: fix verified in staging.' }),
        ],
      },
    ],
  },
  {
    name: 'loop_entropy_collapse',
    description: 'A loop that rewrites its content each time still collapses onto one or two inboxes; entropy catches it where repetition cannot.',
    source: 'packages/agent-guard/test/entropy-collapse-independent.test.ts',
    cases: [
      {
        name: 'two-recipient content-mutating loop',
        config: {},
        steps: [
          ...records(mutatedContentLoop(60)),
          check(NOW, {
            to: 'target@example.com',
            subject: 'Following up, note 60 of my sequence',
            text: 'Message 60: xxx quick thought on your pricing plans; totally new wording entirely unrelated to prior sends. Ref 474540.',
          }),
        ],
      },
      {
        name: 'a diverse window of the same size stays clean',
        config: {},
        steps: [
          ...records(
            Array.from({ length: 60 }, (_, i) => ({
              at: NOW - (60 - i) * 5_000,
              send: {
                to: `lead${i}@company${i % 30}.com`,
                subject: `Update ${i}`,
                text: `Unique message ${i} with plenty of distinct trigrams to keep similarity far below threshold.`,
              },
            })),
          ),
          check(NOW, { to: 'lead60@company30.com', subject: 'Update 60', text: 'A fresh unique message.' }),
        ],
      },
    ],
  },
  {
    name: 'loop_modes',
    description: 'mode full runs both signals, repetition_only ignores recipient collapse, off holds nothing.',
    source: 'packages/agent-guard/test/loop_guard_mode_repetition_only_ignores_entropy_collapse.test.ts',
    cases: [
      {
        name: 'repetition_only does not hold a dominant recipient',
        config: { loop: { mode: 'repetition_only' } },
        steps: [...records(collapsedOwner(30)), check(NOW, { to: 'owner@example.com', subject: 'A new sentence', text: 'Nothing like the alerts.' })],
      },
      {
        name: 'off holds nothing, including a repeated body',
        config: { loop: { mode: 'off' } },
        steps: [
          ...records(collapsedOwner(4).map((t) => ({ ...t, send: { ...t.send, subject: 'same', text: 'same body' } }))),
          check(NOW, { to: 'owner@example.com', subject: 'same', text: 'same body' }),
        ],
      },
      {
        name: 'full holds the dominant recipient',
        config: { loop: { mode: 'full' } },
        steps: [...records(collapsedOwner(30)), check(NOW, { to: 'owner@example.com', subject: 'A new sentence', text: 'Nothing like the alerts.' })],
      },
    ],
  },
  {
    name: 'loop_dominant_recipients',
    description: 'Entropy collapse holds only a send addressed to one of the inboxes the window collapsed on; mail to anyone else keeps flowing.',
    source: 'packages/agent-guard/test/sp04_entropy_collapse_holds_only_dominant_recipients.test.ts',
    cases: [
      {
        name: 'a new recipient passes a collapsed window',
        config: {},
        steps: [...records(alertsTo(['owner@example.test'], 30)), check(NOW, { to: 'new-user@example.com', subject: 'Your sign-in code', text: 'Your code is 481 902.' })],
      },
      {
        name: 'the collapsed inbox is held',
        config: {},
        steps: [...records(alertsTo(['owner@example.test'], 30)), check(NOW, { to: 'owner@example.test', subject: 'Alert 30: new wording', text: 'A different sentence entirely.' })],
      },
      {
        name: 'each address on a send counts',
        config: {},
        steps: [
          ...records(alertsTo(['owner@example.test', 'cfo@example.test'], 30)),
          check(NOW, { to: 'owner@example.test', subject: 'Something else', text: 'Unrelated copy.' }),
        ],
      },
      {
        name: 'a dominant inbox reached through cc is held',
        config: {},
        steps: [
          ...records(alertsTo(['owner@example.test'], 30)),
          check(NOW, { to: 'new-user@example.com', cc: 'owner@example.test', subject: 'Welcome', text: 'Welcome aboard.' }),
        ],
      },
      {
        name: 'cc recipients in the window are counted',
        config: {},
        steps: [
          ...records(alertsTo(['ops-inbox@example.test'], 30).map((t, i) => ({ ...t, send: { ...t.send, to: `rotating-${i % 2}@example.test`, cc: 'owner@example.test' } }))),
          check(NOW, { to: 'owner@example.test', subject: 's', text: 'b' }),
        ],
      },
    ],
  },
  {
    name: 'kill_switch',
    description: 'A paused guard refuses every send, never resumes on a timer, and resumes only through resume().',
    source: 'packages/agent-guard/test/kill-switch-no-auto-resume.test.ts',
    cases: [
      {
        name: 'pause refuses with who, when and why',
        config: {},
        steps: [
          sendStep(1000, { to: 'a@example.com', subject: 'Hello', text: 'First.' }),
          { op: 'pause', at: 2000, reason: 'Agent was looping on one recipient.', by: 'operator-7' },
          check(5000, { to: 'b@example.com', subject: 'Hello', text: 'Second.' }),
        ],
      },
      {
        name: 'a year later it is still paused',
        config: {},
        steps: [
          { op: 'pause', at: 1000, reason: 'Entropy collapse detected.', by: 'trust-system' },
          check(1000 + 365 * 24 * HOUR, { to: 'b@example.com', subject: 'Hello', text: 'Later.' }),
        ],
      },
      {
        name: 'resume re-opens sending; a redundant resume returns false',
        config: {},
        steps: [
          { op: 'resume', at: 500, by: 'operator-3' },
          { op: 'pause', at: 1000, reason: 'Loop suspected.', by: 'operator-7' },
          check(86_400_000, { to: 'c@example.com', subject: 'Hi', text: 'Still paused.' }),
          { op: 'resume', at: 86_400_000, by: 'operator-3' },
          check(86_400_001, { to: 'c@example.com', subject: 'Hi', text: 'Open again.' }),
        ],
      },
      {
        name: 'the latest pause is the one reported',
        config: {},
        steps: [
          { op: 'pause', at: 1, reason: 'one', by: 'a' },
          { op: 'resume', at: 2, by: 'b' },
          { op: 'pause', at: 3, reason: 'three', by: 'c' },
          check(4, { to: 'd@example.com', subject: 'Hi', text: 'x' }),
        ],
      },
      {
        name: 'pause without by uses the default actor, and the default namespace names the state',
        config: {},
        steps: [
          { op: 'pause', at: 1000, reason: 'Default actor.' },
          check(2000, { to: 'a@example.com', subject: 'Hi', text: 'x' }),
          { op: 'read_state', at: 2000, name: 'agent-email-guard:kill' },
          { op: 'resume', at: 3000, by: 'operator-3' },
          { op: 'read_state', at: 3000, name: 'agent-email-guard:kill' },
          { op: 'read_state', at: 3000, name: 'agent-email-guard:kill:last_resume' },
        ],
      },
      {
        name: 'a custom namespace moves every store name',
        config: { namespace: 'acme' },
        steps: [
          { op: 'pause', at: 1000, reason: 'Stop.', by: 'ops' },
          { op: 'read_state', at: 1000, name: 'acme:kill' },
          { op: 'read_state', at: 1000, name: 'agent-email-guard:kill', note: 'the default namespace is untouched' },
        ],
      },
      {
        name: 'the kill switch outranks every other check',
        config: { suppress: ['d@example.com'], budgets: { per_hour: 0 } },
        steps: [{ op: 'pause', at: 1, reason: 'stop', by: 'a' }, check(2, { to: 'd@example.com', subject: 'Hi', text: 'x' })],
      },
    ],
  },
  {
    name: 'budgets',
    description: 'Hourly, daily and monthly budgets per key, counted in UTC calendar periods; check() reserves, release() gives back.',
    source: 'packages/agent-guard/test/b08-budget-race.test.ts',
    cases: [
      {
        name: 'the third send in an hour with a budget of 2 is refused; the next hour opens',
        config: { budgets: { per_hour: 2 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 1000, { to: 'b@example.com', subject: '2', text: 'two' }),
          sendStep(NOW + 2000, { to: 'c@example.com', subject: '3', text: 'three' }),
          sendStep(NOW + HOUR, { to: 'c@example.com', subject: '3', text: 'three' }),
        ],
      },
      {
        name: 'keys count separately',
        config: { budgets: { per_day: 1 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { key: 'billing-agent', to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 1, { key: 'support-agent', to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 2, { key: 'billing-agent', to: 'a@example.com', subject: '2', text: 'two' }),
          sendStep(NOW + 3, { to: 'a@example.com', subject: '3', text: 'default key' }),
        ],
      },
      {
        name: 'a budget of 1 email uses the singular',
        config: { key: 'notifier', budgets: { per_month: 1 }, loop: { mode: 'off' } },
        steps: [
          sendStep(Date.UTC(2027, 0, 31, 23, 59, 59), { to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(Date.UTC(2027, 0, 31, 23, 59, 59, 500), { to: 'a@example.com', subject: '2', text: 'two' }),
          sendStep(Date.UTC(2027, 1, 1), { to: 'a@example.com', subject: '3', text: 'February' }),
        ],
      },
      {
        name: 'the smallest period refuses first, and a refusal gives back what it reserved',
        config: { budgets: { per_hour: 1, per_day: 2 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 1, { to: 'a@example.com', subject: '2', text: 'two' }),
          sendStep(NOW + HOUR, { to: 'a@example.com', subject: '3', text: 'three' }),
          sendStep(NOW + 2 * HOUR, { to: 'a@example.com', subject: '4', text: 'four' }),
        ],
      },
      {
        name: 'release() after a provider failure gives the budget back',
        config: { budgets: { per_hour: 1 }, loop: { mode: 'off' } },
        steps: [
          check(NOW, { to: 'a@example.com', subject: '1', text: 'provider will fail' }),
          { op: 'release', at: NOW + 1, step: 0 },
          { op: 'release', at: NOW + 2, step: 0, note: 'a second release changes nothing' },
          sendStep(NOW + 3, { to: 'a@example.com', subject: '1', text: 'retry' }),
          sendStep(NOW + 4, { to: 'a@example.com', subject: '2', text: 'over' }),
        ],
      },
      {
        name: 'a budget of 0 refuses everything',
        config: { budgets: { per_day: 0 }, loop: { mode: 'off' } },
        steps: [sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'one' })],
      },
    ],
  },
  {
    name: 'rate',
    description: 'A sliding one-minute ceiling per key, independent of the budgets.',
    source: 'packages/agent-guard/test/b08-budget-race.test.ts',
    cases: [
      {
        name: 'the sixth send in a minute with a ceiling of 5 is refused',
        config: { rate: { per_minute: 5 }, loop: { mode: 'off' } },
        steps: [
          ...[0, 1, 2, 3, 4].map((i) => sendStep(NOW + i * 1000, { to: `r${i}@example.com`, subject: `${i}`, text: 'x' })),
          sendStep(NOW + 10_000, { to: 'r5@example.com', subject: '5', text: 'x' }),
          sendStep(NOW + 59_999, { to: 'r5@example.com', subject: '5', text: 'x', }, 'still five inside the minute'),
          sendStep(NOW + 60_000, { to: 'r5@example.com', subject: '5', text: 'x' }, 'the first send left the window'),
        ],
      },
      {
        name: 'a ceiling refusal reserves no budget',
        config: { rate: { per_minute: 1 }, budgets: { per_day: 10 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 1, { to: 'a@example.com', subject: '2', text: 'two' }),
          sendStep(NOW + MIN, { to: 'a@example.com', subject: '3', text: 'three' }),
        ],
      },
      {
        name: 'a budget refusal gives back its rate slot',
        config: { rate: { per_minute: 2 }, budgets: { per_hour: 1 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'one' }),
          sendStep(NOW + 1, { to: 'a@example.com', subject: '2', text: 'two' }),
          sendStep(NOW + 2, { to: 'a@example.com', subject: '3', text: 'three' }),
          sendStep(NOW + HOUR, { to: 'a@example.com', subject: '4', text: 'four' }),
        ],
      },
    ],
  },
  {
    name: 'approval',
    description: 'Approval rules hold a send for a person; holds reserve nothing; an approved re-check skips only the approval rules.',
    source: 'packages/agent-guard/src/approval-policy.ts',
    cases: [
      {
        name: 'domain and exact-address rules',
        config: { approval: { recipients: ['@bigco.com', 'vip@partner.example'] }, loop: { mode: 'off' } },
        steps: [
          check(NOW, { to: 'CEO@BigCo.com', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'someone@partner.example', cc: 'vip@partner.example', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'ceo@notbigco.com.evil', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'ceo@bigco.com', subject: 'Hi', text: 'x' }, { approved: true }),
        ],
      },
      {
        name: 'rules are normalized before they are reported',
        config: { approval: { recipients: ['@BigCo.com', ' VIP <VIP@Partner.Example> '] }, loop: { mode: 'off' } },
        steps: [
          check(NOW, { to: 'ceo@bigco.com', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'vip@partner.example', subject: 'Hi', text: 'x' }),
        ],
      },
      {
        name: 'new recipients wait until a send to them is recorded',
        config: { key: 'agent-1', approval: { new_recipients: true }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: ['known@example.com', 'fresh@example.com'], subject: 'Hi', text: 'x' }),
          sendStep(NOW + 1, { to: 'Known <known@example.com>', subject: 'Hi', text: 'x' }, 'held: neither address has a recorded send yet'),
          { op: 'record', at: NOW + 2, send: { to: 'known@example.com', subject: 'Hi', text: 'approved by a person and sent' } },
          sendStep(NOW + 3, { to: 'Known <KNOWN@example.com>', subject: 'Hi again', text: 'y' }),
          sendStep(NOW + 4, { to: 'known@example.com', bcc: 'fresh@example.com', subject: 'Hi again', text: 'y' }),
        ],
      },
      {
        name: 'requireFor holds with your detail',
        config: { approval: { require_for: { subject_contains: 'refund', detail: 'Refunds over $500 need a person.' } }, loop: { mode: 'off' } },
        steps: [
          check(NOW, { to: 'a@example.com', subject: 'Your refund', text: 'x' }),
          check(NOW, { to: 'a@example.com', subject: 'Your receipt', text: 'x' }),
        ],
      },
      {
        name: 'requireFor returning true holds with no detail',
        config: { approval: { require_for: { subject_contains: 'refund', detail: null } }, loop: { mode: 'off' } },
        steps: [check(NOW, { to: 'a@example.com', subject: 'Your refund', text: 'x' })],
      },
      {
        name: 'a hold reserves no budget, and the approved send spends it',
        config: { approval: { recipients: ['@bigco.com'] }, budgets: { per_hour: 1 }, rate: { per_minute: 1 }, loop: { mode: 'off' } },
        steps: [
          check(NOW, { to: 'ceo@bigco.com', subject: 'Hi', text: 'x' }),
          check(NOW + 1, { to: 'ceo@bigco.com', subject: 'Hi', text: 'x' }, { approved: true }),
          check(NOW + 2, { to: 'other@example.com', subject: 'Hi', text: 'x' }),
        ],
      },
    ],
  },
  {
    name: 'suppression',
    description: 'The suppression list refuses outright; it outranks loop detection and approval.',
    source: 'packages/agent-guard/src/approval-policy.ts',
    cases: [
      {
        name: 'a mixed-case suppression rule is reported normalized',
        config: { suppress: ['@Competitor.EXAMPLE'] },
        steps: [check(NOW, { to: 'Sales@competitor.example', subject: 'Hi', text: 'x' })],
      },
      {
        name: 'exact and domain suppression, through To, Cc and Bcc',
        config: { suppress: ['regulator@gov.example', '@competitor.example'], approval: { recipients: ['regulator@gov.example'] } },
        steps: [
          check(NOW, { to: 'Regulator <regulator@gov.example>', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'a@example.com', bcc: 'sales@competitor.example', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'a@example.com', subject: 'Hi', text: 'x' }),
          check(NOW, { to: 'regulator@gov.example', subject: 'Hi', text: 'x' }, { approved: true }),
        ],
      },
    ],
  },
  {
    name: 'order',
    description: 'The fixed check order: kill switch, suppression, loop, approval, rate, budgets.',
    source: 'oss/agent-guard/spec/SPEC.md §7',
    cases: [
      {
        name: 'loop outranks approval and budgets',
        config: { approval: { recipients: ['victim@example.com'] }, budgets: { per_hour: 0 } },
        steps: [identical(3), check(NOW, ROADMAP)],
      },
      {
        name: 'approval outranks rate and budgets',
        config: { approval: { recipients: ['@example.com'] }, budgets: { per_hour: 0 }, rate: { per_minute: 1 }, loop: { mode: 'off' } },
        steps: [check(NOW, { to: 'a@example.com', subject: 'Hi', text: 'x' })],
      },
      {
        name: 'rate outranks budgets',
        config: { budgets: { per_hour: 1 }, rate: { per_minute: 1 }, loop: { mode: 'off' } },
        steps: [
          sendStep(NOW, { to: 'a@example.com', subject: '1', text: 'x' }),
          sendStep(NOW + 1, { to: 'a@example.com', subject: '2', text: 'x' }),
        ],
      },
      {
        name: 'an empty config allows and reports the loop window',
        config: {},
        steps: [sendStep(NOW, { to: 'a@example.com', subject: 'Hi', text: 'x' }), sendStep(NOW + 1, { to: 'b@example.com', subject: 'Hi', html: '<p>x</p>' })],
      },
      {
        name: 'an empty text falls back to html',
        description: 'The body is text when it is non-empty, else html. Three sends whose text is empty and whose html matches are a repetition loop.',
        config: {},
        steps: [
          { op: 'record', at: NOW - 3000, send: { to: 'a@example.com', subject: 'Hi', text: '', html: '<p>Your code is 1234</p>' }, repeat: 3, every_ms: 1000 },
          check(NOW, { to: 'a@example.com', subject: 'Hi', text: '', html: '<p>Your code is 1234</p>' }),
          check(NOW, { to: 'a@example.com', subject: 'Hi', text: 'A completely different plain body.', html: '<p>Your code is 1234</p>' }),
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Reference cross-check (monorepo only).
// ---------------------------------------------------------------------------

let comparedSteps = 0;

type RefDetect = (
  window: Array<{ to: string; recipients?: string[]; subject: string; body: string; sentAt: number }>,
  candidate: { to: string; recipients?: string[]; subject: string; body: string },
  now: number,
  config: Record<string, unknown>,
) => { verdict: string; decision: { outcome: string; reason: string; evidence: Record<string, unknown> } };

async function loadReference(): Promise<RefDetect | null> {
  if (!existsSync(REFERENCE)) return null;
  const mod = (await import(pathToFileURL(REFERENCE).href)) as { detectLoop: RefDetect };
  return mod.detectLoop;
}

function refShape(send: VectorSend): { to: string; recipients: string[]; subject: string; body: string } {
  const to = addressList(send.to);
  const recipients = [...to];
  for (const a of [...addressList(send.cc), ...addressList(send.bcc)]) if (!recipients.includes(a)) recipients.push(a);
  return { to: [...to].sort().join(','), recipients, subject: send.subject ?? '', body: send.text ? send.text : (send.html ?? '') };
}

/** Replays the loop-relevant steps of a case through the reference; returns mismatch descriptions. */
function crossCheck(ref: RefDetect, c: VectorCase, results: Array<ExpectedDecision | { resumed: boolean } | { state: unknown } | null>): string[] {
  if (c.config.loop?.mode === 'off') return [];
  if (c.config.approval || c.config.suppress || c.config.budgets || c.config.rate) return [];
  if (c.steps.some((s) => s.op === 'pause' || s.op === 'resume')) return [];
  const mode = c.config.loop?.mode === 'repetition_only' ? 'repetition-only' : (c.config.loop?.mode ?? 'full');
  const cfg = {
    mode,
    ...(c.config.loop?.window_ms !== undefined ? { windowMs: c.config.loop.window_ms } : {}),
    ...(c.config.loop?.max_identical_sends !== undefined ? { maxIdenticalSends: c.config.loop.max_identical_sends } : {}),
  };
  const window: Array<{ to: string; recipients: string[]; subject: string; body: string; sentAt: number }> = [];
  const problems: string[] = [];
  for (const [i, step] of c.steps.entries()) {
    if (step.op === 'record') {
      for (let k = 0; k < (step.repeat ?? 1); k++) window.push({ ...refShape(step.send), sentAt: step.at + k * (step.every_ms ?? 0) });
    } else if (step.op === 'check' || step.op === 'send') {
      const refResult = ref_(ref, window, step.send, step.at, cfg);
      comparedSteps++;
      const ours = results[i] as ExpectedDecision;
      if (refResult.decision.outcome !== ours.outcome || refResult.decision.reason !== ours.reason) {
        problems.push(`${c.name} step ${i}: reference ${refResult.decision.outcome}/${refResult.decision.reason}, ours ${ours.outcome}/${ours.reason}`);
      }
      for (const field of ['matching_sends_in_window', 'distinct_recipients', 'effective_recipients', 'candidate_recipient_share', 'window_size']) {
        const r = refResult.decision.evidence[field];
        const o = ours.evidence[field];
        if (r !== undefined && o !== undefined && Math.abs(Number(r) - Number(o)) > 0.0015) {
          problems.push(`${c.name} step ${i}: ${field} reference ${String(r)}, ours ${String(o)}`);
        }
      }
      if (step.op === 'send' && ours.outcome === 'allow') window.push({ ...refShape(step.send), sentAt: step.at });
    }
  }
  return problems;
}

function ref_(ref: RefDetect, window: Parameters<RefDetect>[0], send: VectorSend, at: number, cfg: Record<string, unknown>) {
  return ref(window, refShape(send), at, cfg);
}

// ---------------------------------------------------------------------------

// Policy-file validation (SPEC §2.9). Lives in vectors/policy/ so the step runners' top-level glob skips it.
const POLICY_CASES: Array<{ name: string; policy: unknown }> = [
  { name: 'an empty object is valid', policy: {} },
  {
    name: 'every key at once is valid',
    policy: {
      $schema: 'https://example.test/agent-email-guard.schema.json',
      $comment: 'Limits for the support agent.',
      version: 1,
      key: 'support-agent',
      namespace: 'acme',
      budgets: { per_hour: 50, per_day: 300, per_month: 5000 },
      rate: { per_minute: 10 },
      loop: { mode: 'full', window_ms: 3600000, similarity_threshold: 0.85, max_identical_sends: 3, min_window_for_entropy: 20, recipient_perplexity_floor: 3 },
      approval: { new_recipients: true, recipients: ['@bigcustomer.com'] },
      suppress: ['@competitor.example'],
    },
  },
  { name: '$comment may hold any JSON value', policy: { $comment: ['line one', 'line two'] } },
  { name: 'namespace must be a non-empty string', policy: { namespace: '' } },
  { name: 'camelCase keys are unknown', policy: { budgets: { perDay: 3 }, rate: { perMinute: 1 } } },
  { name: 'wrong types and unknown keys are all reported, in key order', policy: { budgets: { per_hour: -1, per_day: 1.5 }, loop: { mode: 'loose' }, extra: 1, version: 2 } },
  { name: 'nested sections must be objects', policy: { budgets: 5, approval: [] } },
  { name: 'similarity_threshold must be above 0', policy: { loop: { similarity_threshold: 0 } } },
  { name: 'suppress must be a list of strings', policy: { suppress: ['a@example.com', 3] } },
  { name: 'the policy must be an object', policy: [] },
];

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const ref = await loadReference();
  const problems: string[] = [];
  let changed = 0;
  for (const file of FILES) {
    for (const c of file.cases) {
      const results = await runCase(c);
      const actual = results.map((r) => r.actual);
      if (ref) problems.push(...crossCheck(ref, c, actual));
      for (const r of results) {
        const step = c.steps[r.index] as VectorStep;
        if (r.actual !== null && (step.op === 'check' || step.op === 'send' || step.op === 'resume' || step.op === 'read_state')) {
          (step as { expect?: unknown }).expect = r.actual;
        }
      }
    }
    const out = `${JSON.stringify({ $schema: './vector.schema.json', ...file }, null, 2)}\n`;
    const path = join(VECTORS, `${file.name}.json`);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (existing !== out) {
      changed++;
      if (checkOnly) problems.push(`${file.name}.json differs from a fresh run`);
      else writeFileSync(path, out);
    }
  }
  const policyFile = {
    name: 'policy_validation',
    description: 'agent-email-guard.json validation (SPEC §2.9): the exact problem sentences, in order. An empty list means the policy is valid.',
    cases: POLICY_CASES.map((c) => ({ name: c.name, policy: c.policy, expect: { problems: validatePolicy(c.policy) } })),
  };
  const policyOut = `${JSON.stringify(policyFile, null, 2)}\n`;
  const policyPath = join(VECTORS, 'policy', 'validation.json');
  const policyExisting = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';
  if (policyExisting !== policyOut) {
    changed++;
    if (checkOnly) problems.push('policy/validation.json differs from a fresh run');
    else {
      mkdirSync(join(VECTORS, 'policy'), { recursive: true });
      writeFileSync(policyPath, policyOut);
    }
  }
  process.stdout.write(`${FILES.length} files, ${FILES.reduce((n, f) => n + f.cases.length, 0)} cases; ${checkOnly ? 'differing' : 'written'}: ${changed}; reference cross-check: ${ref ? `${comparedSteps} loop steps agree with packages/agent-guard` : 'skipped (not in the monorepo)'}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}

await main();
