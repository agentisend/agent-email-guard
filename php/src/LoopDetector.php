<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * Loop detection (SPEC §5): two independent signals over a key's recent
 * accepted sends.
 *
 *  1. Repetition: near-identical sends (same To line, subject AND body
 *     trigram similarity at or above the threshold) inside the window.
 *     Catches the retry loop that sends one message 4,000 times.
 *  2. Recipient entropy: a looping agent's recipients collapse onto one or
 *     two inboxes even when it rewrites the content each time. Collapse only
 *     holds a candidate addressed to one of the dominant inboxes, so a key
 *     that pages its owner 30 times an hour still sends a sign-in code to a
 *     new user.
 */
final class LoopDetector
{
    private function __construct()
    {
    }

    /** @param list<SendRecord> $recent */
    public static function detect(array $recent, SendRecord $candidate, int $now, LoopConfig $cfg): LoopResult
    {
        $window = [];
        foreach ($recent as $send) {
            if ($now - $send->at <= $cfg->windowMs) {
                $window[] = $send;
            }
        }

        // Signal 1: repetition.
        $matches = 0;
        $closestSubject = 0.0;
        $closestBody = 0.0;
        $closestSum = -1.0;
        $candSubject = null;
        $candBody = null;
        foreach ($window as $prior) {
            if ($prior->toLine !== $candidate->toLine) {
                continue;
            }
            if ($prior->subject === $candidate->subject) {
                $s = 1.0;
            } else {
                $candSubject ??= Text::trigrams($candidate->subject);
                $s = Text::jaccard(Text::trigrams($prior->subject), $candSubject);
            }
            if ($s < $cfg->similarityThreshold) {
                continue;
            }
            if ($prior->body === $candidate->body) {
                $b = 1.0;
            } else {
                $candBody ??= Text::trigrams($candidate->body);
                $b = Text::jaccard(Text::trigrams($prior->body), $candBody);
            }
            if ($b < $cfg->similarityThreshold) {
                continue;
            }
            $matches++;
            if ($s + $b > $closestSum) {
                $closestSum = $s + $b;
                $closestSubject = $s;
                $closestBody = $b;
            }
        }
        $repetitionFlagged = $cfg->mode !== LoopConfig::MODE_OFF && $matches >= $cfg->maxIdenticalSends;

        // Signal 2: recipient entropy. Each address on a send counts once, in first-seen order.
        $counts = [];
        $slots = 0;
        foreach ($window as $send) {
            foreach ($send->recipients as $r) {
                $counts[$r] = ($counts[$r] ?? 0) + 1;
                $slots++;
            }
        }
        $bits = 0.0;
        foreach ($counts as $c) {
            $p = $c / $slots;
            $bits -= $p * log($p, 2);
        }
        $perplexity = 2 ** $bits;
        $trusted = count($window) >= $cfg->minWindowForEntropy;
        $collapsed = $trusted && $perplexity < $cfg->recipientPerplexityFloor;
        $dominantShareFloor = 1 / $cfg->recipientPerplexityFloor;
        $candidateShare = 0.0;
        if ($slots > 0) {
            foreach ($candidate->recipients as $r) {
                $candidateShare = max($candidateShare, ($counts[$r] ?? 0) / $slots);
            }
        }
        $entropyFlagged = $cfg->mode === LoopConfig::MODE_FULL && $collapsed && $candidateShare >= $dominantShareFloor;

        $stats = [
            'window_size' => count($window),
            'distinct_recipients' => count($counts),
            'entropy_bits' => Format::round3($bits),
            'effective_recipients' => Format::round3($perplexity),
        ];

        if (!$repetitionFlagged && !$entropyFlagged) {
            return new LoopResult(LoopResult::CLEAN, null, $stats, $matches, $collapsed, $candidateShare, $perplexity, $trusted);
        }

        $verdict = $repetitionFlagged && $entropyFlagged
            ? LoopResult::BOTH_SIGNALS
            : ($repetitionFlagged ? LoopResult::REPETITION_LOOP : LoopResult::ENTROPY_COLLAPSE);
        $evidence = [
            'signal_repetition' => $repetitionFlagged,
            'signal_entropy' => $entropyFlagged,
            'matching_sends_in_window' => $matches,
            'repetition_threshold' => $cfg->maxIdenticalSends,
            'closest_subject_similarity' => $matches > 0 ? Format::round3($closestSubject) : null,
            'closest_body_similarity' => $matches > 0 ? Format::round3($closestBody) : null,
            ...$stats,
            'perplexity_floor' => self::plainNumber($cfg->recipientPerplexityFloor),
            'candidate_recipient_share' => Format::round3($candidateShare),
            'dominant_share_floor' => Format::round3($dominantShareFloor),
            'window_ms' => $cfg->windowMs,
        ];
        $minutes = (int) floor($cfg->windowMs / 60000 + 0.5);
        $effective = Format::round3($perplexity);
        $message = match ($verdict) {
            LoopResult::REPETITION_LOOP => Messages::loopRepetition($matches, $candidate->toLine, $minutes),
            LoopResult::ENTROPY_COLLAPSE => Messages::entropyCollapse(count($window), $effective),
            default => Messages::loopBothSignals($matches, $candidate->toLine, $effective),
        };
        $reason = $repetitionFlagged ? Reason::LOOP_REPETITION_DETECTED : Reason::RECIPIENT_ENTROPY_COLLAPSE;

        return new LoopResult(
            $verdict,
            new Decision(Outcome::REFUSE, $reason, $message, $evidence),
            $stats,
            $matches,
            $collapsed,
            $candidateShare,
            $perplexity,
            $trusted,
        );
    }

    private static function plainNumber(float $n): int|float
    {
        return floor($n) === $n && abs($n) < 9.0e15 ? (int) $n : $n;
    }
}
