<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Tests\Support\Traffic;
use PHPUnit\Framework\TestCase;

/** Port of packages/agent-guard/test/loop-4000-repetition.test.ts. */
final class LoopRepetitionTest extends TestCase
{
    private const SEND = [
        'to' => 'victim@example.com',
        'subject' => 'Quick question about your roadmap',
        'text' => 'Hi — I wanted to follow up on my last note about your Q3 roadmap. Any interest?',
    ];

    /** @return list<SendRecord> */
    private static function identicalSends(int $count): array
    {
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            // 10ms apart: all 4,000 sit inside one 60-minute window.
            $out[] = Traffic::record(self::SEND, Traffic::NOW - ($count - $i) * 10);
        }
        return $out;
    }

    public function testCatchesTheCandidateThatWouldBeThe4001stNearIdenticalSend(): void
    {
        $result = Traffic::detect(self::identicalSends(4000), self::SEND);
        self::assertContains($result->verdict, [LoopResult::REPETITION_LOOP, LoopResult::BOTH_SIGNALS]);
        self::assertNotNull($result->decision);
        self::assertSame(Outcome::REFUSE, $result->decision->outcome);
        self::assertSame(Reason::LOOP_REPETITION_DETECTED, $result->decision->reason);
    }

    public function testCarriesCountsWindowAndSimilarityInTheEvidence(): void
    {
        $candidate = ['text' => 'Hi — I wanted to follow up on my last note about my Q3 roadmap. Any interest?'] + self::SEND;
        $decision = Traffic::detect(self::identicalSends(4000), $candidate)->decision;
        self::assertNotNull($decision);
        self::assertSame(4000, $decision->evidence['matching_sends_in_window']);
        self::assertSame(3, $decision->evidence['repetition_threshold']);
        self::assertSame(3_600_000, $decision->evidence['window_ms']);
        self::assertGreaterThan(0.99, $decision->evidence['closest_subject_similarity']);
        // The body was tweaked slightly ("my" vs "your") and must still match.
        self::assertGreaterThanOrEqual(0.85, $decision->evidence['closest_body_similarity']);
    }

    public function testExplainsItselfInOneSentenceEndingInAPeriod(): void
    {
        $decision = Traffic::detect(self::identicalSends(4000), self::SEND)->decision;
        self::assertNotNull($decision);
        self::assertStringContainsString('near-identical emails', $decision->message);
        self::assertStringEndsWith('.', $decision->message);
        self::assertTrue($decision->isValid());
    }

    public function testFlagsOnceTheThresholdIsCrossedNotBefore(): void
    {
        self::assertSame(LoopResult::CLEAN, Traffic::detect(self::identicalSends(2), self::SEND)->verdict);
        self::assertSame(LoopResult::REPETITION_LOOP, Traffic::detect(self::identicalSends(3), self::SEND)->verdict);
    }

    public function testSendsOutsideTheWindowDoNotCount(): void
    {
        $stale = [];
        for ($i = 0; $i < 50; $i++) {
            $stale[] = Traffic::record(self::SEND, Traffic::NOW - 2 * 3_600_000);
        }
        self::assertSame(LoopResult::CLEAN, Traffic::detect($stale, self::SEND)->verdict);
    }
}
