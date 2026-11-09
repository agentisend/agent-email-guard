<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Decision;
use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Reason;
use PHPUnit\Framework\TestCase;

/**
 * Port of packages/agent-guard/test/refusal-tokens.test.ts: every block the
 * guard can produce carries a token and a human sentence. The hosted-only
 * tokens (trust_paused, brand_impersonation) never come from this library.
 */
final class RefusalTokensTest extends TestCase
{
    private const NOW = 1_800_000_000_000;

    /** @return list<Decision> */
    private static function allBlocks(): array
    {
        $now = self::NOW;
        $clock = static function () use (&$now): int {
            return $now;
        };
        $blocks = [];

        // Loop: repetition (with entropy too) and entropy alone.
        $guard = Guard::create(['clock' => $clock]);
        for ($i = 0; $i < 30; $i++) {
            $now = self::NOW - (30 - $i) * 1000;
            $guard->record(['to' => 'same@recipient.com', 'subject' => 'identical subject', 'text' => 'body variant ' . ($i % 3)]);
        }
        $now = self::NOW;
        $blocks[] = $guard->check(['to' => 'same@recipient.com', 'subject' => 'identical subject', 'text' => 'body variant 1']);
        $guard = Guard::create(['clock' => $clock]);
        for ($i = 0; $i < 25; $i++) {
            $now = self::NOW - (25 - $i) * 100;
            $guard->record(['to' => 'one@x.com', 'subject' => "s{$i} " . str_repeat('q', $i), 'text' => "b {$i} " . str_repeat('w', $i)]);
        }
        $now = self::NOW;
        $blocks[] = $guard->check(['to' => 'one@x.com', 'subject' => 'new', 'text' => 'new']);

        // Budget and rate.
        $guard = Guard::create(['clock' => $clock, 'budgets' => ['perMonth' => 1]]);
        $guard->check(['to' => 'a@x.com']);
        $blocks[] = $guard->check(['to' => 'b@x.com']);
        $guard = Guard::create(['clock' => $clock, 'rate' => ['perMinute' => 1]]);
        $guard->check(['to' => 'a@x.com']);
        $blocks[] = $guard->check(['to' => 'b@x.com']);

        // Kill switch.
        $guard = Guard::create(['clock' => $clock]);
        $guard->killSwitch()->pause('why', 'op');
        $blocks[] = $guard->check(['to' => 'a@x.com']);

        // Suppression and the three approval holds.
        $guard = Guard::create([
            'clock' => $clock,
            'suppress' => ['regulator@gov.example'],
            'approval' => ['recipients' => ['@bigco.com'], 'newRecipients' => true, 'requireFor' => static fn (array $s): bool => ($s['subject'] ?? '') === 'refund'],
        ]);
        $blocks[] = $guard->check(['to' => 'regulator@gov.example']);
        $blocks[] = $guard->check(['to' => 'ceo@bigco.com']);
        $blocks[] = $guard->check(['to' => 'a@x.com', 'subject' => 'refund']);
        $blocks[] = $guard->check(['to' => 'a@x.com']);

        return array_values(array_filter($blocks, static fn (Decision $d): bool => !$d->isAllowed()));
    }

    public function testEveryBlockingSubsystemProducesItsToken(): void
    {
        $reasons = array_map(static fn (Decision $d): string => $d->reason, self::allBlocks());
        foreach (array_diff(Reason::TOKENS, [Reason::OK]) as $token) {
            self::assertContains($token, $reasons);
        }
        self::assertCount(9, $reasons);
    }

    public function testEveryBlockMeetsTheDecisionContract(): void
    {
        foreach (self::allBlocks() as $d) {
            self::assertTrue($d->isValid(), 'contract violated by: ' . json_encode($d));
            self::assertContains($d->reason, Reason::TOKENS);
            self::assertGreaterThan(30, strlen($d->message));
            self::assertDoesNotMatchRegularExpression('/\bnull\b|\bArray\b|\[object/', $d->message);
        }
    }

    public function testHostedOnlyTokensAreNotPartOfThisLibrary(): void
    {
        self::assertNotContains('trust_paused', Reason::TOKENS);
        self::assertNotContains('brand_impersonation', Reason::TOKENS);
        self::assertSame(
            ['ok', 'kill_switch_active', 'recipient_suppressed', 'loop_repetition_detected', 'recipient_entropy_collapse', 'recipient_requires_approval', 'rate_ceiling_exceeded', 'agent_budget_exceeded'],
            Reason::TOKENS,
        );
    }

    public function testADecisionSurvivesAProcessBoundary(): void
    {
        $guard = Guard::create(['budgets' => ['perHour' => 5], 'rate' => ['perMinute' => 5], 'clock' => static fn (): int => self::NOW]);
        $decision = $guard->check(['to' => 'a@x.com']);
        $json = json_encode($decision, JSON_THROW_ON_ERROR);
        /** @var array{outcome: string, reason: string, message: string, evidence: array<string, string|int|float|bool|null>, reservation?: array{key: string, counters: list<array{name: string, amount: int}>, window: array{name: string, member: string}|null}} $data */
        $data = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        $guard->release(Decision::fromArray($data));
        self::assertSame(1, $guard->check(['to' => 'a@x.com'])->evidence['hour_used']);
    }
}
