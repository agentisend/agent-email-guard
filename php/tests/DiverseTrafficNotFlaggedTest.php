<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Tests\Support\Traffic;
use PHPUnit\Framework\TestCase;

/** Port of packages/agent-guard/test/diverse-traffic-not-flagged.test.ts. */
final class DiverseTrafficNotFlaggedTest extends TestCase
{
    private const FIRST = ['ana', 'belle', 'carlos', 'dee', 'elena', 'farid', 'gita', 'hugo', 'ines', 'jonas'];
    private const LAST = ['acme', 'bright', 'cedarline', 'deltaworks', 'everly', 'foxglove', 'granitetech'];
    private const TOPICS = ['invoice', 'receipt', 'welcome', 'password reset', 'weekly digest', 'shipping notice'];

    /** @return list<SendRecord> */
    private static function legitimateTraffic(int $count, int $seed): array
    {
        $rand = Traffic::lcg($seed);
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $to = Traffic::pick(self::FIRST, $rand) . '@' . Traffic::pick(self::LAST, $rand) . '.com';
            $subject = 'Your ' . Traffic::pick(self::TOPICS, $rand) . ' (#' . (int) floor($rand() * 100000) . ')';
            $body = 'Hello ' . Traffic::pick(self::FIRST, $rand) . ', here are the details you asked for regarding '
                . Traffic::pick(self::TOPICS, $rand) . '. Reference ' . (int) floor($rand() * 1e9) . '.';
            $out[] = Traffic::record(['to' => $to, 'subject' => $subject, 'text' => $body], Traffic::NOW - ($count - $i) * 30_000);
        }
        return $out;
    }

    public function testClears120VariedTransactionalSends(): void
    {
        $result = Traffic::detect(self::legitimateTraffic(120, 42), [
            'to' => 'newcustomer@brightco.io',
            'subject' => 'Your invoice (#88213)',
            'text' => 'Hello ana, here are the details you asked for regarding invoice. Reference 554032987.',
        ]);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
        self::assertNull($result->decision);
        self::assertGreaterThan(40, $result->stats['distinct_recipients']);
        self::assertGreaterThan(10, $result->stats['effective_recipients']);
        self::assertSame(0, $result->matches);
    }

    public function testClearsASmallHonestAgentBelowTheEntropySampleFloor(): void
    {
        // A 12-send sample cannot support a collapse verdict.
        $result = Traffic::detect(self::legitimateTraffic(12, 7), ['to' => 'one@of-the-three.com', 'subject' => 's', 'text' => 'b']);
        self::assertFalse($result->trustedSample);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
    }

    public function testDoesNotFlagRepeatCorrespondenceWhenContentDiffers(): void
    {
        // A support agent answers the same 25 customers many times, every message written apart.
        $window = [];
        for ($round = 0; $round < 6; $round++) {
            for ($c = 0; $c < 25; $c++) {
                $window[] = Traffic::record([
                    'to' => "customer{$c}@theirco.com",
                    'subject' => "Re: ticket {$c} update {$round}",
                    'text' => "Round {$round} for ticket {$c}: we reproduced the issue on build {$round}{$c} and shipped a fix candidate.",
                ], Traffic::NOW - (150 - count($window)) * 20_000);
            }
        }
        $result = Traffic::detect($window, [
            'to' => 'customer7@theirco.com',
            'subject' => 'Re: ticket 7 update 6',
            'text' => 'Round 6 for ticket 7: fix verified in staging.',
        ]);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
        self::assertNotSame(Reason::RECIPIENT_ENTROPY_COLLAPSE, $result->decision?->reason);
    }
}
