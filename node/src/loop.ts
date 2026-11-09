/**
 * Loop detection (SPEC §5): two independent signals over the key's recent
 * accepted sends.
 *
 *  1. Repetition: near-identical sends (same To line, subject AND body
 *     trigram similarity >= threshold) inside the window. Catches the retry
 *     loop that sends one message 4,000 times.
 *  2. Recipient entropy: a looping agent's recipients collapse toward one or
 *     two inboxes even when it rewrites the content each time. Collapse only
 *     holds a candidate addressed to one of the dominant inboxes, so a key
 *     that pages its owner 30 times an hour still sends a sign-in code to a
 *     new user.
 */

import { MESSAGES, round3, type Decision, decision, type DecisionEvidence } from './decisions.js';
import { jaccard, trigrams } from './text.js';
import type { SendRecord } from './store.js';

export type LoopMode = 'off' | 'repetition_only' | 'full';

export interface LoopConfig {
  readonly mode?: LoopMode;
  /** Rolling window length in ms. */
  readonly windowMs?: number;
  /** Subject and body similarity both at or above this count as near-identical. */
  readonly similarityThreshold?: number;
  /** Refuse when this many near-identical sends are already in the window. */
  readonly maxIdenticalSends?: number;
  /** Entropy is only trusted on a window of at least this many sends. */
  readonly minWindowForEntropy?: number;
  /** Collapse when the effective number of recipients (2^entropy) is below this. */
  readonly recipientPerplexityFloor?: number;
}

export const LOOP_DEFAULTS = {
  mode: 'full' as LoopMode,
  windowMs: 60 * 60 * 1000,
  similarityThreshold: 0.85,
  maxIdenticalSends: 3,
  minWindowForEntropy: 20,
  recipientPerplexityFloor: 3,
} as const;

export type ResolvedLoopConfig = { [K in keyof typeof LOOP_DEFAULTS]: K extends 'mode' ? LoopMode : number };

export function resolveLoopConfig(config: LoopConfig | undefined): ResolvedLoopConfig {
  return {
    mode: config?.mode ?? LOOP_DEFAULTS.mode,
    windowMs: config?.windowMs ?? LOOP_DEFAULTS.windowMs,
    similarityThreshold: config?.similarityThreshold ?? LOOP_DEFAULTS.similarityThreshold,
    maxIdenticalSends: config?.maxIdenticalSends ?? LOOP_DEFAULTS.maxIdenticalSends,
    minWindowForEntropy: config?.minWindowForEntropy ?? LOOP_DEFAULTS.minWindowForEntropy,
    recipientPerplexityFloor: config?.recipientPerplexityFloor ?? LOOP_DEFAULTS.recipientPerplexityFloor,
  };
}

export type Candidate = Omit<SendRecord, 'at'>;

export interface LoopResult {
  readonly verdict: 'clean' | 'repetition_loop' | 'entropy_collapse' | 'both_signals';
  /** A refuse decision, or null when clean. */
  readonly decision: Decision | null;
  /** Window statistics, reported on an allow too. */
  readonly stats: DecisionEvidence;
}

export function detectLoop(
  recent: readonly SendRecord[],
  candidate: Candidate,
  now: number,
  cfg: ResolvedLoopConfig,
): LoopResult {
  const window = recent.filter((s) => now - s.at <= cfg.windowMs);

  // Signal 1: repetition.
  let matches = 0;
  let closestSubject = 0;
  let closestBody = 0;
  let closestSum = -1;
  const candSubject = trigrams(candidate.subject);
  const candBody = trigrams(candidate.body);
  for (const prior of window) {
    if (prior.toLine !== candidate.toLine) continue;
    const s = prior.subject === candidate.subject ? 1 : jaccard(trigrams(prior.subject), candSubject);
    if (s < cfg.similarityThreshold) continue;
    const b = prior.body === candidate.body ? 1 : jaccard(trigrams(prior.body), candBody);
    if (b < cfg.similarityThreshold) continue;
    matches++;
    if (s + b > closestSum) {
      closestSum = s + b;
      closestSubject = s;
      closestBody = b;
    }
  }
  const repetitionFlagged = cfg.mode !== 'off' && matches >= cfg.maxIdenticalSends;

  // Signal 2: recipient entropy. Each address on a send counts once.
  const counts = new Map<string, number>();
  let slots = 0;
  for (const send of window) {
    for (const r of send.recipients) {
      counts.set(r, (counts.get(r) ?? 0) + 1);
      slots++;
    }
  }
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / slots;
    bits -= p * Math.log2(p);
  }
  const perplexity = Math.pow(2, bits);
  const trusted = window.length >= cfg.minWindowForEntropy;
  const collapsed = trusted && perplexity < cfg.recipientPerplexityFloor;
  const dominantShareFloor = 1 / cfg.recipientPerplexityFloor;
  let candidateShare = 0;
  if (slots > 0) {
    for (const r of candidate.recipients) candidateShare = Math.max(candidateShare, (counts.get(r) ?? 0) / slots);
  }
  const entropyFlagged = cfg.mode === 'full' && collapsed && candidateShare >= dominantShareFloor;

  const stats: DecisionEvidence = {
    window_size: window.length,
    distinct_recipients: counts.size,
    entropy_bits: round3(bits),
    effective_recipients: round3(perplexity),
  };

  if (!repetitionFlagged && !entropyFlagged) return { verdict: 'clean', decision: null, stats };

  const verdict = repetitionFlagged && entropyFlagged ? 'both_signals' : repetitionFlagged ? 'repetition_loop' : 'entropy_collapse';
  const evidence: DecisionEvidence = {
    signal_repetition: repetitionFlagged,
    signal_entropy: entropyFlagged,
    matching_sends_in_window: matches,
    repetition_threshold: cfg.maxIdenticalSends,
    closest_subject_similarity: matches > 0 ? round3(closestSubject) : null,
    closest_body_similarity: matches > 0 ? round3(closestBody) : null,
    ...stats,
    perplexity_floor: cfg.recipientPerplexityFloor,
    candidate_recipient_share: round3(candidateShare),
    dominant_share_floor: round3(dominantShareFloor),
    window_ms: cfg.windowMs,
  };
  const minutes = Math.floor(cfg.windowMs / 60000 + 0.5);
  const effective = round3(perplexity);
  const message =
    verdict === 'repetition_loop'
      ? MESSAGES.loop_repetition_detected(matches, candidate.toLine, minutes)
      : verdict === 'entropy_collapse'
        ? MESSAGES.recipient_entropy_collapse(window.length, effective)
        : MESSAGES.loop_both_signals(matches, candidate.toLine, effective);
  return {
    verdict,
    stats,
    decision: decision('refuse', repetitionFlagged ? 'loop_repetition_detected' : 'recipient_entropy_collapse', message, evidence),
  };
}
