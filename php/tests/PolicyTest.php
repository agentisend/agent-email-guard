<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Policy;
use AgentiSend\AgentEmailGuard\Reason;
use PHPUnit\Framework\TestCase;

final class PolicyTest extends TestCase
{
    public function testAPolicyFileBuildsTheSameGuardAsTheConfig(): void
    {
        $path = sys_get_temp_dir() . '/agent-email-guard-' . bin2hex(random_bytes(4)) . '.json';
        file_put_contents($path, json_encode([
            '$schema' => 'https://example.test/schema.json',
            'version' => 1,
            'key' => 'support-agent',
            'budgets' => ['per_hour' => 1],
            'approval' => ['recipients' => ['@bigco.com']],
            'suppress' => ['regulator@gov.example'],
        ], JSON_THROW_ON_ERROR));
        try {
            $guard = Guard::fromPolicy($path, ['approval' => ['requireFor' => static fn (array $s): bool => ($s['subject'] ?? '') === 'refund']]);
            self::assertSame(Reason::RECIPIENT_SUPPRESSED, $guard->check(['to' => 'regulator@gov.example'])->reason);
            self::assertTrue($guard->check(['to' => 'ceo@bigco.com'])->isHeld());
            self::assertTrue($guard->check(['to' => 'a@x.com', 'subject' => 'refund'])->isHeld());
            $ok = $guard->check(['to' => 'a@x.com']);
            self::assertSame('support-agent', $ok->evidence['key']);
            self::assertSame(Reason::AGENT_BUDGET_EXCEEDED, $guard->check(['to' => 'b@x.com'])->reason);
        } finally {
            unlink($path);
        }
    }

    public function testEveryProblemIsNamed(): void
    {
        self::assertSame(['The policy must be a JSON object.'], Policy::validate([1, 2]));
        self::assertSame([], Policy::validate(new \stdClass()));
        self::assertSame([
            'Unknown key "budget".',
            '"rate.per_minute" has the wrong type.',
            'Unknown key "approval.require_for".',
            '"loop.mode" has the wrong type.',
        ], Policy::validate([
            'budget' => 5,
            'rate' => ['per_minute' => -1],
            'approval' => ['require_for' => 'code'],
            'loop' => ['mode' => 'sometimes'],
        ]));
        $this->expectException(\InvalidArgumentException::class);
        Policy::load('/nonexistent/agent-email-guard.json');
    }
}
