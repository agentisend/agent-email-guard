<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;
use PHPUnit\Framework\TestCase;

/** Port of packages/agent-guard/test/kill-switch-no-auto-resume.test.ts, on the public Guard API. */
final class KillSwitchNoAutoResumeTest extends TestCase
{
    private int $now = 1_000;

    private function guard(): Guard
    {
        return Guard::create(['clock' => fn (): int => $this->now]);
    }

    private const SEND = ['to' => 'someone@example.com', 'subject' => 'Hi', 'text' => 'Hello.'];

    public function testRefusesEverySendWhilePausedWithWhoWhenWhy(): void
    {
        $guard = $this->guard();
        self::assertSame(Outcome::ALLOW, $guard->check(self::SEND)->outcome);

        $guard->killSwitch()->pause('Agent was looping on one recipient.', 'operator-7');
        $this->now = 5_000;

        $decision = $guard->check(self::SEND);
        self::assertSame(Outcome::REFUSE, $decision->outcome);
        self::assertSame(Reason::KILL_SWITCH_ACTIVE, $decision->reason);
        self::assertSame('operator-7', $decision->evidence['paused_by']);
        self::assertSame(1_000, $decision->evidence['paused_at']);
        self::assertSame('Agent was looping on one recipient.', $decision->evidence['pause_reason']);
        self::assertTrue($decision->isValid());
    }

    public function testNeverResumesOnATimer(): void
    {
        $guard = $this->guard();
        $guard->killSwitch()->pause('Entropy collapse detected.', 'trust-system');
        $this->now += 365 * 24 * 60 * 60 * 1000;
        self::assertTrue($guard->killSwitch()->state()->paused);
        self::assertSame(Reason::KILL_SWITCH_ACTIVE, $guard->check(self::SEND)->reason);
    }

    public function testResumesOnlyThroughAnExplicitResumeAndRecordsIt(): void
    {
        $guard = $this->guard();
        $guard->killSwitch()->pause('Loop suspected.', 'operator-7');
        $this->now = 86_400_000;
        self::assertTrue($guard->killSwitch()->state()->paused);

        self::assertTrue($guard->killSwitch()->resume('operator-3'));
        self::assertFalse($guard->killSwitch()->state()->paused);
        self::assertSame(Outcome::ALLOW, $guard->check(self::SEND)->outcome);

        $audit = json_decode((string) $guard->store()->getState('agent-email-guard:kill:last_resume'), true);
        self::assertIsArray($audit);
        self::assertSame('operator-7', $audit['paused_by']);
        self::assertSame('Loop suspected.', $audit['reason']);
        self::assertSame(1_000, $audit['paused_at']);
        self::assertSame('operator-3', $audit['resumed_by']);
        self::assertSame(86_400_000, $audit['resumed_at']);
    }

    public function testARedundantResumeReturnsFalseAndRecordsNothing(): void
    {
        $guard = $this->guard();
        self::assertFalse($guard->killSwitch()->resume('op'));
        self::assertNull($guard->store()->getState('agent-email-guard:kill:last_resume'));
    }

    public function testRePausingReportsTheLatestPause(): void
    {
        $guard = $this->guard();
        $guard->killSwitch()->pause('one', 'a');
        $guard->killSwitch()->resume('b');
        $guard->killSwitch()->pause('three', 'c');
        self::assertTrue($guard->killSwitch()->state()->paused);
        self::assertSame('c', $guard->check(self::SEND)->evidence['paused_by']);
    }

    public function testThePauseCoversEveryKeyOnTheGuard(): void
    {
        $guard = $this->guard();
        $guard->killSwitch()->pause('stop', 'ops');
        self::assertSame(Reason::KILL_SWITCH_ACTIVE, $guard->check(['key' => 'billing'] + self::SEND)->reason);
        self::assertSame(Reason::KILL_SWITCH_ACTIVE, $guard->check(['key' => 'support'] + self::SEND)->reason);
    }
}
