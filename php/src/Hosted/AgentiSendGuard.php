<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

use AgentiSend\AgentEmailGuard\ApprovalRequired;
use AgentiSend\AgentEmailGuard\Decision;
use AgentiSend\AgentEmailGuard\GuardRefused;
use AgentiSend\AgentEmailGuard\Messages;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;

/**
 * The hosted adapter (SPEC §8). The same rules, enforced by the AgentiSend
 * API on the key itself: every process using the key shares one budget, one
 * rate ceiling, one loop guard and one kill switch, and code the agent runs
 * cannot remove them. Give the agent a key with limits set in the console;
 * this class reads and tightens them, and sends.
 *
 * Every call goes to a real endpoint:
 *   check()            POST  /emails/preflight     runs every send gate, sends nothing
 *   send()             POST  /emails
 *   killSwitch()       POST  /limits/keys/{keyId}/kill   (resume is a person's action in the console)
 *   limits()           GET   /limits/keys/{keyId}
 *   setLimits()        PATCH /limits/keys/{keyId}       (a key may only lower its own limits)
 *   pendingApprovals() GET   /agent-actions?state=pending
 */
final class AgentiSendGuard
{
    public const DEFAULT_BASE_URL = 'https://api.agentisend.com';

    /** API error codes that are guard decisions, and the token each becomes. */
    public const CODE_TO_REASON = [
        'kill_switch_active' => Reason::KILL_SWITCH_ACTIVE,
        'agent_budget_exceeded' => Reason::AGENT_BUDGET_EXCEEDED,
        'rate_ceiling_exceeded' => Reason::RATE_CEILING_EXCEEDED,
        'approval_required' => Reason::RECIPIENT_REQUIRES_APPROVAL,
        'suppressed_recipient' => Reason::RECIPIENT_SUPPRESSED,
    ];

    private const PERIODS = ['hour' => 'hourly', 'hourly' => 'hourly', 'day' => 'daily', 'daily' => 'daily', 'month' => 'monthly', 'monthly' => 'monthly'];

    private readonly HttpClient $http;
    private readonly string $baseUrl;

    /**
     * @param string $apiKey an AgentiSend API key (as_...)
     * @param string|null $keyId that key's id (shown in the console under API keys); needed for limits and the kill switch
     */
    public function __construct(
        private readonly string $apiKey,
        private readonly ?string $keyId = null,
        string $baseUrl = self::DEFAULT_BASE_URL,
        ?HttpClient $http = null,
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->http = $http ?? new CurlHttpClient();
    }

    /**
     * Ask the API whether this send would go out, without sending it.
     *
     * @param array<string, mixed> $send the same send array Guard::check() takes, plus any AgentiSend send field (from is required by the API)
     */
    public function check(array $send): Decision
    {
        $report = $this->request('POST', '/emails/preflight', self::body($send));
        $error = is_array($report['error'] ?? null) ? $report['error'] : null;
        if (($report['ok'] ?? false) === true || $error === null) {
            return new Decision(Outcome::ALLOW, Reason::OK, Messages::ok(), [
                'hosted' => true,
                'simulated' => ($report['simulated'] ?? false) === true,
            ]);
        }
        $decision = self::decisionFor($error);
        if ($decision === null) {
            throw self::apiError(200, $error, $report);
        }
        return $decision;
    }

    /**
     * Send through AgentiSend. A refusal throws GuardRefused, a hold throws
     * ApprovalRequired (a person approves it in the console, which sends it;
     * approve() on it throws HumanActionRequired). Other API errors throw ApiError.
     *
     * @param array<string, mixed> $send
     * @return array<string, mixed> the API's reply ({id, ...})
     */
    public function send(array $send): array
    {
        try {
            return $this->request('POST', '/emails', self::body($send));
        } catch (ApiError $e) {
            $error = is_array($e->body['error'] ?? null) ? $e->body['error'] : ['code' => $e->errorCode, 'message' => $e->getMessage(), 'fix' => $e->fix];
            $decision = self::decisionFor($error);
            if ($decision === null) {
                throw $e;
            }
            if ($decision->isHeld()) {
                throw new ApprovalRequired($decision, static function (): never {
                    throw new HumanActionRequired('A held send is approved by a person in the AgentiSend console (Agents, Approvals); approving it sends it.');
                });
            }
            throw new GuardRefused($decision);
        }
    }

    public function killSwitch(): HostedKillSwitch
    {
        return new HostedKillSwitch($this);
    }

    /** @return array<string, mixed> budget_per_period, period, consumed_in_period, rate_ceiling_per_minute, paused, ... */
    public function limits(): array
    {
        return $this->request('GET', '/limits/keys/' . rawurlencode($this->keyId()));
    }

    /**
     * Lower this key's limits. Pass only what changes; null clears a ceiling.
     * Raising a limit is a person's decision in the console and the API refuses it.
     *
     * @param array{budget?: int|null, period?: string, perMinute?: int|null} $limits period: hour|day|month (or hourly|daily|monthly)
     * @return array<string, mixed>
     */
    public function setLimits(array $limits): array
    {
        $body = [];
        if (array_key_exists('budget', $limits)) {
            $body['budget_per_period'] = $limits['budget'];
        }
        if (isset($limits['period'])) {
            $period = self::PERIODS[$limits['period']] ?? null;
            if ($period === null) {
                throw new \InvalidArgumentException('period must be hour, day or month.');
            }
            $body['period'] = $period;
        }
        if (array_key_exists('perMinute', $limits)) {
            $body['rate_ceiling_per_minute'] = $limits['perMinute'];
        }
        if ($body === []) {
            throw new \InvalidArgumentException('Pass at least one of budget, period or perMinute.');
        }
        return $this->request('PATCH', '/limits/keys/' . rawurlencode($this->keyId()), $body);
    }

    /**
     * Held sends waiting for a person. Approving and rejecting happen in the console.
     *
     * @return list<array<string, mixed>>
     */
    public function pendingApprovals(): array
    {
        $page = $this->request('GET', '/agent-actions?state=pending');
        $out = [];
        foreach (is_array($page['data'] ?? null) ? $page['data'] : [] as $row) {
            if (is_array($row)) {
                $out[] = self::stringKeys($row);
            }
        }
        return $out;
    }

    /** @internal */
    public function keyId(): string
    {
        if ($this->keyId === null || $this->keyId === '') {
            throw new \LogicException('Pass the API key\'s id (console, API keys) as keyId to read or change its limits or pull its kill switch.');
        }
        return $this->keyId;
    }

    /**
     * @internal
     * @param array<string, mixed>|null $body
     * @return array<string, mixed>
     */
    public function request(string $method, string $path, ?array $body = null): array
    {
        $headers = [
            'Authorization' => 'Bearer ' . $this->apiKey,
            'Accept' => 'application/json',
            'User-Agent' => 'agent-email-guard-php/0.1',
        ];
        $payload = null;
        if ($body !== null) {
            $headers['Content-Type'] = 'application/json';
            $payload = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        $response = $this->http->request($method, $this->baseUrl . $path, $headers, $payload);
        $decoded = $response['body'] === '' ? [] : json_decode($response['body'], true);
        $data = is_array($decoded) ? self::stringKeys($decoded) : [];
        if ($response['status'] >= 400) {
            $error = is_array($data['error'] ?? null) ? $data['error'] : $data;
            throw self::apiError($response['status'], $error, $data);
        }
        return $data;
    }

    /**
     * @param array<array-key, mixed> $error
     */
    private static function decisionFor(array $error): ?Decision
    {
        $code = is_string($error['code'] ?? null) ? $error['code'] : '';
        $reason = self::CODE_TO_REASON[$code] ?? null;
        if ($reason === null) {
            return null;
        }
        $message = is_string($error['message'] ?? null) ? $error['message'] : $code;
        $evidence = [
            'hosted' => true,
            'code' => $code,
            'fix' => is_string($error['fix'] ?? null) ? $error['fix'] : null,
        ];
        if (is_string($error['action_id'] ?? null)) {
            $evidence['action_id'] = $error['action_id'];
        }
        $outcome = $reason === Reason::RECIPIENT_REQUIRES_APPROVAL ? Outcome::HOLD_FOR_APPROVAL : Outcome::REFUSE;
        return new Decision($outcome, $reason, $message, $evidence);
    }

    /**
     * @param array<array-key, mixed> $error
     * @param array<string, mixed> $body
     */
    private static function apiError(int $status, array $error, array $body): ApiError
    {
        $code = is_string($error['code'] ?? null) ? $error['code'] : 'unknown_error';
        $message = is_string($error['message'] ?? null) ? $error['message'] : "AgentiSend answered {$status}.";
        $fix = is_string($error['fix'] ?? null) ? $error['fix'] : null;
        return new ApiError($status, $code, $message, $fix, $body);
    }

    /**
     * The guard send minus the guard-only key field.
     *
     * @param array<string, mixed> $send
     * @return array<string, mixed>
     */
    private static function body(array $send): array
    {
        unset($send['key']);
        return $send;
    }

    /**
     * @param array<array-key, mixed> $data
     * @return array<string, mixed>
     */
    private static function stringKeys(array $data): array
    {
        $out = [];
        foreach ($data as $k => $v) {
            $out[(string) $k] = $v;
        }
        return $out;
    }
}
