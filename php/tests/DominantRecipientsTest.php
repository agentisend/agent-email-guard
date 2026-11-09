<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Tests\Support\Traffic;
use PHPUnit\Framework\TestCase;

/**
 * Port of packages/agent-guard/test/sp04_entropy_collapse_holds_only_dominant_recipients.test.ts.
 * A key that sends 20+ alerts an hour to its owner still sends a sign-in code to a new user.
 */
final class DominantRecipientsTest extends TestCase
{
    /**
     * @param list<string> $recipients
     * @return list<SendRecord>
     */
    private static function alertsTo(array $recipients, int $count): array
    {
        $kinds = ['disk', 'queue', 'latency', 'errors'];
        $regions = ['north', 'south', 'east', 'west'];
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $out[] = Traffic::record([
                'to' => implode(',', $recipients),
                'subject' => "Alert {$i}: {$kinds[$i % 4]} on host " . ($i * 13),
                'text' => "Check {$i} crossed its threshold at step " . ($i * 7919) . '; ' . str_repeat('z', $i % 9) . " {$regions[$i % 4]} region.",
            ], Traffic::NOW - ($count - $i) * 60_000);
        }
        return $out;
    }

    public function testLetsASendToANewRecipientThroughACollapsedKey(): void
    {
        $result = Traffic::detect(self::alertsTo(['owner@warmy.test'], 30), [
            'to' => 'new-user@example.com', 'subject' => 'Your sign-in code', 'text' => 'Your code is 481 902.',
        ]);
        self::assertTrue($result->windowCollapsed);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
    }

    public function testStillHoldsTheNextSendToTheInboxTheWindowCollapsedOn(): void
    {
        $result = Traffic::detect(self::alertsTo(['owner@warmy.test'], 30), [
            'to' => 'owner@warmy.test', 'subject' => 'Alert 30: new wording', 'text' => 'A different sentence entirely.',
        ]);
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, $result->verdict);
        self::assertNotNull($result->decision);
        self::assertSame(Reason::RECIPIENT_ENTROPY_COLLAPSE, $result->decision->reason);
        self::assertEquals(1, $result->decision->evidence['candidate_recipient_share']);
    }

    public function testCountsEachAddressSoALoopCannotHideBehindACoRecipient(): void
    {
        $window = self::alertsTo(['owner@warmy.test', 'cfo@warmy.test'], 30);
        $result = Traffic::detect($window, ['to' => 'owner@warmy.test', 'subject' => 'Something else', 'text' => 'Unrelated copy.']);
        self::assertSame(2, $result->stats['distinct_recipients']);
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, $result->verdict);
    }

    public function testHoldsACandidateThatReachesADominantInboxThroughCc(): void
    {
        $result = Traffic::detect(self::alertsTo(['owner@warmy.test'], 30), [
            'to' => 'new-user@example.com', 'cc' => 'owner@warmy.test', 'subject' => 'Welcome', 'text' => 'Welcome aboard.',
        ]);
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, $result->verdict);
    }

    public function testReadsCcRecipientsInTheWindowNotOnlyTheToLine(): void
    {
        $window = [];
        foreach (self::alertsTo(['ops-inbox@warmy.test'], 30) as $i => $send) {
            $window[] = new SendRecord(
                'rotating-' . ($i % 2) . '@warmy.test',
                ['rotating-' . ($i % 2) . '@warmy.test', 'owner@warmy.test'],
                $send->subject,
                $send->body,
                $send->at,
            );
        }
        $result = Traffic::detect($window, ['to' => 'owner@warmy.test', 'subject' => 's', 'text' => 'b']);
        self::assertSame(3, $result->stats['distinct_recipients']);
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, $result->verdict);
    }
}
