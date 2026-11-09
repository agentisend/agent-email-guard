<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Tests\Support\Traffic;
use PHPUnit\Framework\TestCase;

/** Port of packages/agent-guard/test/entropy-collapse-independent.test.ts. */
final class EntropyCollapseIndependentTest extends TestCase
{
    /**
     * Same two recipients over and over, every body rewritten enough to defeat
     * trigram similarity. Repetition must not fire; entropy must.
     *
     * @return list<SendRecord>
     */
    private static function mutatedContentLoop(int $count): array
    {
        $topics = ['pricing', 'roadmap', 'team', 'growth'];
        $seasons = ['spring', 'summer', 'autumn', 'winter'];
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $out[] = Traffic::record([
                'to' => $i % 2 === 0 ? 'target@example.com' : 'target2@example.com',
                'subject' => "Following up — note {$i} of my sequence",
                'text' => "Message {$i}: " . str_repeat('x', 3 + ($i % 7)) . " quick thought on your {$topics[$i % 4]}"
                    . " plans; happy to share what we learned with teams like yours this {$seasons[$i % 4]}. Ref " . ($i * 7919) . '.',
            ], Traffic::NOW - ($count - $i) * 5_000);
        }
        return $out;
    }

    public function testFlagsATwoRecipientContentMutatingLoopRepetitionCannotSee(): void
    {
        $result = Traffic::detect(self::mutatedContentLoop(60), [
            'to' => 'target@example.com',
            'subject' => 'Following up — note 60 of my sequence',
            'text' => 'Message 60: xxx quick thought on your pricing plans; totally new wording entirely unrelated to prior sends. Ref 474540.',
        ]);
        self::assertSame(0, $result->matches);
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, $result->verdict);
        self::assertNotNull($result->decision);
        self::assertSame(Reason::RECIPIENT_ENTROPY_COLLAPSE, $result->decision->reason);
        self::assertSame(Outcome::REFUSE, $result->decision->outcome);
    }

    public function testReportsTheEntropyMathInTheEvidence(): void
    {
        $result = Traffic::detect(self::mutatedContentLoop(60), ['to' => 'target@example.com', 'subject' => 'new', 'text' => 'new body text']);
        self::assertSame(2, $result->stats['distinct_recipients']);
        // A perfectly even split over 2 recipients is exactly 1 bit.
        self::assertEqualsWithDelta(1.0, $result->stats['entropy_bits'], 1e-5);
        self::assertEqualsWithDelta(2.0, $result->effectiveRecipients, 1e-3);
        self::assertNotNull($result->decision);
        self::assertEqualsWithDelta(2.0, $result->decision->evidence['effective_recipients'], 1e-3);
        self::assertSame(2, $result->decision->evidence['distinct_recipients']);
        self::assertMatchesRegularExpression('/recipients/', $result->decision->message);
    }

    public function testKeepsADiverseWindowOfTheSameSizeClean(): void
    {
        $diverse = [];
        for ($i = 0; $i < 60; $i++) {
            $diverse[] = Traffic::record([
                'to' => "lead{$i}@company" . ($i % 30) . '.com',
                'subject' => "Outreach {$i}",
                'text' => "Unique message {$i} with plenty of distinct trigrams to keep similarity far below threshold.",
            ], Traffic::NOW - (60 - $i) * 5_000);
        }
        $result = Traffic::detect($diverse, ['to' => 'lead60@company30.com', 'subject' => 'Outreach 60', 'text' => 'A fresh unique message.']);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
    }
}
