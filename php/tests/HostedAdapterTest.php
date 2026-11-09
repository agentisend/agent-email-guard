<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\ApprovalRequired;
use AgentiSend\AgentEmailGuard\GuardRefused;
use AgentiSend\AgentEmailGuard\Hosted\AgentiSendGuard;
use AgentiSend\AgentEmailGuard\Hosted\ApiError;
use AgentiSend\AgentEmailGuard\Hosted\HumanActionRequired;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\Tests\Support\StubHttp;
use PHPUnit\Framework\TestCase;

/** SPEC §8: the hosted adapter calls real AgentiSend endpoints and maps their error codes. */
final class HostedAdapterTest extends TestCase
{
    private const KEY_ID = '7f8e0c1a-1111-4222-8333-944455556666';
    private const SEND = ['key' => 'ignored', 'from' => 'Agent <agent@example.com>', 'to' => 'user@example.com', 'subject' => 'Hi', 'text' => 'Hello.'];

    /**
     * @param list<array{status: int, body: array<string, mixed>}> $responses
     * @param-out StubHttp $http
     */
    private static function adapter(array $responses, mixed &$http = null): AgentiSendGuard
    {
        $http = new StubHttp($responses);
        return new AgentiSendGuard('as_test', self::KEY_ID, 'https://api.example.test/', $http);
    }

    /**
     * @param array<string, string> $extra
     * @return array{status: int, body: array<string, mixed>}
     */
    private static function envelope(int $status, string $code, string $message, array $extra = []): array
    {
        return ['status' => $status, 'body' => ['statusCode' => $status, 'name' => $code, 'message' => $message, 'error' => ['code' => $code, 'message' => $message, 'fix' => 'Do the fix.'] + $extra]];
    }

    public function testCheckCallsPreflightAndAllowsWhenEveryGatePasses(): void
    {
        $guard = self::adapter([['status' => 200, 'body' => ['ok' => true, 'simulated' => false, 'error' => null, 'checks' => []]]], $http);
        $decision = $guard->check(self::SEND);
        self::assertSame(Outcome::ALLOW, $decision->outcome);
        self::assertTrue($decision->isValid());
        self::assertSame('POST', $http->requests[0]['method']);
        self::assertSame('https://api.example.test/emails/preflight', $http->requests[0]['url']);
        self::assertSame('Bearer as_test', $http->requests[0]['headers']['Authorization']);
        self::assertArrayNotHasKey('key', $http->requests[0]['body'] ?? []);
        self::assertSame('user@example.com', ($http->requests[0]['body'] ?? [])['to']);
    }

    public function testPreflightErrorsBecomeDecisionsWithTheApiSentence(): void
    {
        $guard = self::adapter([
            ['status' => 200, 'body' => ['ok' => false, 'simulated' => false, 'error' => ['code' => 'agent_budget_exceeded', 'message' => 'Key budget for the current period is exhausted.', 'fix' => 'Wait.'], 'checks' => []]],
            ['status' => 200, 'body' => ['ok' => false, 'simulated' => false, 'error' => ['code' => 'approval_required', 'message' => 'This action requires human approval before it executes.', 'fix' => 'Wait.', 'action_id' => 'a1'], 'checks' => []]],
        ]);
        $budget = $guard->check(self::SEND);
        self::assertSame(Reason::AGENT_BUDGET_EXCEEDED, $budget->reason);
        self::assertSame('Key budget for the current period is exhausted.', $budget->message);
        self::assertSame('Wait.', $budget->evidence['fix']);
        $held = $guard->check(self::SEND);
        self::assertSame(Outcome::HOLD_FOR_APPROVAL, $held->outcome);
        self::assertSame('a1', $held->evidence['action_id']);
    }

    public function testAPreflightErrorThatIsNotAGuardDecisionThrowsTheApiError(): void
    {
        $guard = self::adapter([['status' => 200, 'body' => ['ok' => false, 'simulated' => false, 'error' => ['code' => 'domain_not_verified', 'message' => 'Verify the domain first.', 'fix' => 'Verify it.'], 'checks' => []]]]);
        $this->expectException(ApiError::class);
        $this->expectExceptionMessage('Verify the domain first.');
        $guard->check(self::SEND);
    }

    public function testSendMapsEveryGuardCodeAndPassesTheRestThrough(): void
    {
        $codes = [
            'kill_switch_active' => Reason::KILL_SWITCH_ACTIVE,
            'rate_ceiling_exceeded' => Reason::RATE_CEILING_EXCEEDED,
            'suppressed_recipient' => Reason::RECIPIENT_SUPPRESSED,
            'agent_budget_exceeded' => Reason::AGENT_BUDGET_EXCEEDED,
        ];
        foreach ($codes as $code => $reason) {
            try {
                self::adapter([self::envelope(403, $code, 'Blocked by the API.')])->send(self::SEND);
                self::fail("{$code} did not throw");
            } catch (GuardRefused $e) {
                self::assertSame($reason, $e->reason);
                self::assertSame($code, $e->decision->evidence['code']);
            }
        }
        $ok = self::adapter([['status' => 200, 'body' => ['id' => 'm1']]])->send(self::SEND);
        self::assertSame('m1', $ok['id']);

        $this->expectException(ApiError::class);
        self::adapter([self::envelope(401, 'invalid_api_key', 'That key is not valid.')])->send(self::SEND);
    }

    public function testAHeldSendCannotBeApprovedByTheKey(): void
    {
        try {
            self::adapter([self::envelope(403, 'approval_required', 'Held for a person.', ['action_id' => 'act-9'])])->send(self::SEND);
            self::fail('no hold');
        } catch (ApprovalRequired $e) {
            self::assertSame('act-9', $e->decision->evidence['action_id']);
            $this->expectException(HumanActionRequired::class);
            $e->approve();
        }
    }

    public function testKillSwitchLimitsAndApprovalsUseTheLimitsEndpoints(): void
    {
        $view = ['api_key_id' => self::KEY_ID, 'budget_per_period' => 100, 'period' => 'daily', 'paused' => true, 'paused_at' => '2027-01-15T08:00:00.000Z', 'paused_reason' => 'looping'];
        $guard = self::adapter([
            ['status' => 200, 'body' => $view],
            ['status' => 200, 'body' => $view],
            ['status' => 200, 'body' => ['budget_per_period' => 50, 'period' => 'hourly']],
            ['status' => 200, 'body' => ['object' => 'list', 'data' => [['id' => 'act-1', 'state' => 'pending']]]],
        ], $http);
        $state = $guard->killSwitch()->pause('looping');
        self::assertTrue($state->paused);
        self::assertSame('looping', $state->reason);
        self::assertSame(1_800_000_000_000, $state->pausedAt);
        self::assertTrue($guard->killSwitch()->state()->paused);
        $guard->setLimits(['budget' => 50, 'period' => 'hour', 'perMinute' => null]);
        self::assertSame([['id' => 'act-1', 'state' => 'pending']], $guard->pendingApprovals());

        $calls = array_map(static fn (array $r): string => $r['method'] . ' ' . $r['url'], $http->requests);
        self::assertSame([
            'POST https://api.example.test/limits/keys/' . self::KEY_ID . '/kill',
            'GET https://api.example.test/limits/keys/' . self::KEY_ID,
            'PATCH https://api.example.test/limits/keys/' . self::KEY_ID,
            'GET https://api.example.test/agent-actions?state=pending',
        ], $calls);
        self::assertSame(['reason' => 'looping'], $http->requests[0]['body']);
        self::assertSame(['budget_per_period' => 50, 'period' => 'hourly', 'rate_ceiling_per_minute' => null], $http->requests[2]['body']);

        $this->expectException(HumanActionRequired::class);
        $guard->killSwitch()->resume();
    }

    public function testLimitsNeedTheKeyId(): void
    {
        $this->expectException(\LogicException::class);
        (new AgentiSendGuard('as_test', null, 'https://api.example.test', new StubHttp([])))->limits();
    }
}
