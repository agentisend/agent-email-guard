<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Tests\Support\Traffic;
use PHPUnit\Framework\TestCase;

/** Port of packages/agent-guard/test/loop_guard_mode_repetition_only_ignores_entropy_collapse.test.ts. */
final class RepetitionOnlyIgnoresEntropyCollapseTest extends TestCase
{
    /** @return list<SendRecord> */
    private static function collapsed(int $count, ?string $subject = null, ?string $body = null): array
    {
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $out[] = Traffic::record([
                'to' => 'owner@example.com',
                'subject' => $subject ?? "Alert {$i} " . str_repeat('abc', $i % 5),
                'text' => $body ?? 'Reading ' . ($i * 17) . ' crossed ' . str_repeat('z', $i % 7) . " in region {$i}.",
            ], Traffic::NOW - ($count - $i) * 60_000);
        }
        return $out;
    }

    private const CANDIDATE = ['to' => 'owner@example.com', 'subject' => 'A new sentence', 'text' => 'Nothing like the alerts.'];

    public function testDoesNotHoldADominantRecipientInRepetitionOnlyMode(): void
    {
        $result = Traffic::detect(self::collapsed(30), self::CANDIDATE, ['mode' => 'repetition_only']);
        self::assertTrue($result->windowCollapsed);
        self::assertSame(LoopResult::CLEAN, $result->verdict);
    }

    public function testHoldsNothingWhenTheModeIsOffIncludingARepeatedBody(): void
    {
        $result = Traffic::detect(
            self::collapsed(4, 'same', 'same body'),
            ['to' => 'owner@example.com', 'subject' => 'same', 'text' => 'same body'],
            ['mode' => 'off'],
        );
        self::assertSame(LoopResult::CLEAN, $result->verdict);
    }

    public function testStillHoldsTheDominantRecipientInFullMode(): void
    {
        self::assertSame(LoopResult::ENTROPY_COLLAPSE, Traffic::detect(self::collapsed(30), self::CANDIDATE, ['mode' => 'full'])->verdict);
    }

    public function testTheGuardAcceptsTheHyphenatedSpellingOfTheReferencePackage(): void
    {
        $guard = Guard::create(['loop' => ['mode' => 'repetition-only']]);
        self::assertTrue($guard->check(self::CANDIDATE)->isAllowed());
    }
}
