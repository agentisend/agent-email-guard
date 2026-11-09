<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

use AgentiSend\AgentEmailGuard\Store\MemoryStore;
use AgentiSend\AgentEmailGuard\Store\Store;

/**
 * agent-email-guard: decide, before an AI agent sends an email, whether the send is
 * allowed, held for a person, or refused (SPEC §2, §7).
 *
 * check() runs, in this order, stopping at the first block:
 *   1. kill switch          refuse  kill_switch_active
 *   2. suppression list     refuse  recipient_suppressed
 *   3. loop detection       refuse  loop_repetition_detected | recipient_entropy_collapse
 *   4. approval rules       hold    recipient_requires_approval   (skipped when approved)
 *   5. rate ceiling         refuse  rate_ceiling_exceeded         (reserves)
 *   6. budgets hour→month   refuse  agent_budget_exceeded         (reserves)
 *   7. allow                        ok
 * Nothing before step 5 reserves anything, so a refusal or hold never needs
 * undoing; a budget refusal at step 6 gives back what steps 5–6 reserved.
 *
 * The guard is advisory: it runs in the agent's own process, and code the
 * agent controls can remove it. AgentiSend enforces the same rules at its API,
 * where the agent cannot (see Hosted\AgentiSendGuard).
 */
final class Guard
{
    public const DEFAULT_KEY = 'default';
    public const DEFAULT_NAMESPACE = 'agent-email-guard';

    private const HOUR = 3_600_000;
    private const DAY = 86_400_000;
    private const MINUTE = 60_000;

    private static int $memberCounter = 0;

    private readonly KillSwitch $killSwitch;

    /** @var \WeakMap<Reservation, true> */
    private \WeakMap $released;

    /**
     * @param list<array{0: 'hour'|'day'|'month', 1: int}> $budgets
     * @param list<string> $suppress
     * @param list<string> $approvalRecipients
     * @param (\Closure(array<string, mixed>): mixed)|null $requireFor
     * @param \Closure(): int $clock
     */
    private function __construct(
        private readonly Store $store,
        private readonly \Closure $clock,
        private readonly string $namespace,
        private readonly string $defaultKey,
        private readonly array $budgets,
        private readonly ?int $perMinute,
        private readonly LoopConfig $loop,
        private readonly array $suppress,
        private readonly array $approvalRecipients,
        private readonly bool $newRecipients,
        private readonly ?\Closure $requireFor,
    ) {
        $this->killSwitch = new KillSwitch($store, $namespace . ':kill', $clock);
        /** @var \WeakMap<Reservation, true> $released */
        $released = new \WeakMap();
        $this->released = $released;
    }

    /**
     * Build a guard. Keys may be camelCase (as below) or snake_case.
     *
     * [
     *   'key'       => 'support-agent',                 // default key for sends that name none
     *   'budgets'   => ['perHour' => 50, 'perDay' => 500, 'perMonth' => 10000],
     *   'rate'      => ['perMinute' => 10],
     *   'loop'      => ['mode' => 'full'],              // full | repetition_only | off, plus LoopConfig::DEFAULTS
     *   'approval'  => ['recipients' => ['@bigco.com'], 'newRecipients' => false, 'requireFor' => fn (array $send) => ...],
     *   'suppress'  => ['regulator@gov.example'],
     *   'store'     => new RedisStore($redis),          // default: MemoryStore
     *   'clock'     => fn (): int => ...,               // epoch ms; for tests
     *   'namespace' => 'agent-email-guard',
     * ]
     *
     * @param array<string, mixed> $config
     */
    public static function create(array $config = []): self
    {
        $store = Config::get($config, 'store') ?? new MemoryStore();
        if (!$store instanceof Store) {
            throw new \InvalidArgumentException('store must implement ' . Store::class . '.');
        }

        $clockOption = Config::get($config, 'clock');
        if ($clockOption === null) {
            $clock = static fn (): int => (int) floor(microtime(true) * 1000);
        } elseif (is_callable($clockOption)) {
            $clock = static function () use ($clockOption): int {
                return Config::int($clockOption(), 'clock()');
            };
        } else {
            throw new \InvalidArgumentException('clock must be a callable returning epoch milliseconds.');
        }

        $namespace = Config::get($config, 'namespace') ?? self::DEFAULT_NAMESPACE;
        $key = Config::get($config, 'key') ?? self::DEFAULT_KEY;
        if (!is_string($namespace) || $namespace === '' || !is_string($key) || $key === '') {
            throw new \InvalidArgumentException('key and namespace must be non-empty strings.');
        }

        $budgetConfig = Config::section($config, 'budgets');
        $budgets = [];
        foreach (['hour' => 'perHour', 'day' => 'perDay', 'month' => 'perMonth'] as $period => $field) {
            $value = Config::get($budgetConfig, $field);
            if ($value !== null) {
                $budgets[] = [$period, self::nonNegative($value, "budgets.{$field}")];
            }
        }

        $rateValue = Config::get(Config::section($config, 'rate'), 'perMinute');
        $perMinute = $rateValue === null ? null : self::nonNegative($rateValue, 'rate.perMinute');

        /** @var array<string, mixed> $loopSection */
        $loopSection = Config::section($config, 'loop');
        $loop = LoopConfig::fromArray($loopSection);

        $approval = Config::section($config, 'approval');
        $requireFor = Config::get($approval, 'requireFor');
        if ($requireFor !== null && !is_callable($requireFor)) {
            throw new \InvalidArgumentException('approval.requireFor must be callable.');
        }

        return new self(
            $store,
            $clock,
            $namespace,
            $key,
            $budgets,
            $perMinute,
            $loop,
            Config::stringList(Config::get($config, 'suppress'), 'suppress'),
            Config::stringList(Config::get($approval, 'recipients'), 'approval.recipients'),
            (bool) Config::get($approval, 'newRecipients', false),
            $requireFor === null ? null : \Closure::fromCallable($requireFor),
        );
    }

    /**
     * Build a guard from agent-email-guard.json (default: in the working
     * directory). $overrides adds what a file cannot hold: store, clock,
     * approval.requireFor, or any value to replace.
     *
     * @param array<string, mixed> $overrides
     */
    public static function fromPolicy(?string $path = null, array $overrides = []): self
    {
        return self::create(self::stringKeys(array_replace_recursive(Policy::load($path), $overrides)));
    }

    /**
     * Decide one send. A send is an array: key?, to, cc?, bcc?, from?,
     * subject?, text?, html?. Address fields take a string ("a@x.com, B <b@y.com>"),
     * ['address' => ...] / ['email' => ...], or a list of those.
     *
     * An allow reserves rate and budget: call record() once the provider
     * accepts, or release() if it fails.
     *
     * @param array<string, mixed> $send
     * @param array{approved?: bool} $options approved: a person approved this send; the approval rules are skipped.
     */
    public function check(array $send, array $options = []): Decision
    {
        $now = ($this->clock)();
        $key = $this->keyOf($send);

        // 1. Kill switch.
        $kill = $this->killSwitch->state();
        if ($kill->paused) {
            return new Decision(Outcome::REFUSE, Reason::KILL_SWITCH_ACTIVE, Messages::killSwitchActive(), [
                'paused_at' => $kill->pausedAt,
                'paused_by' => $kill->pausedBy,
                'pause_reason' => $kill->reason,
            ]);
        }

        $candidate = SendRecord::fromSend($send, $now);

        // 2. Suppression.
        $suppressed = self::firstRuleMatch($candidate->recipients, $this->suppress);
        if ($suppressed !== null) {
            [$recipient, $rule] = $suppressed;
            return new Decision(
                Outcome::REFUSE,
                Reason::RECIPIENT_SUPPRESSED,
                Messages::recipientSuppressed($recipient, $rule),
                ['recipient' => $recipient, 'matched_rule' => $rule],
            );
        }

        // 3. Loop detection.
        /** @var array<string, string|int|float|bool|null> $evidence */
        $evidence = ['key' => $key];
        if ($this->loop->mode !== LoopConfig::MODE_OFF) {
            $recent = $this->store->recentSends($this->logName($key), $now - $this->loop->windowMs);
            $loop = LoopDetector::detect($recent, $candidate, $now, $this->loop);
            if ($loop->decision !== null) {
                return $loop->decision;
            }
            $evidence += $loop->stats;
        }

        // 4. Approval.
        if (($options['approved'] ?? false) === true) {
            $evidence['approved'] = true;
        } else {
            $held = $this->approvalHold($send, $candidate, $key);
            if ($held !== null) {
                return $held;
            }
        }

        // 5. Rate ceiling (reserves a window slot).
        $counters = [];
        $windowSlot = null;
        if ($this->perMinute !== null) {
            $name = "{$this->namespace}:{$key}:rate";
            $member = self::newMember($now);
            $result = $this->store->windowAdd($name, $member, $now, self::MINUTE, $this->perMinute);
            if (!$result->ok) {
                $retry = $result->oldestAt === null
                    ? 60
                    : max(1, (int) ceil(($result->oldestAt + self::MINUTE - $now) / 1000));
                return new Decision(
                    Outcome::REFUSE,
                    Reason::RATE_CEILING_EXCEEDED,
                    Messages::rateCeilingExceeded($key, $this->perMinute, $retry),
                    [
                        'key' => $key,
                        'sends_in_window' => $result->count,
                        'ceiling_per_minute' => $this->perMinute,
                        'retry_after_seconds' => $retry,
                    ],
                );
            }
            $windowSlot = ['name' => $name, 'member' => $member];
            $evidence['rate_used'] = $result->count;
            $evidence['rate_ceiling'] = $this->perMinute;
        }

        // 6. Budgets, hour → day → month (each reserves one).
        foreach ($this->budgets as [$period, $budget]) {
            [$start, $end] = self::periodBounds($period, $now);
            $name = "{$this->namespace}:{$key}:budget:{$period}:{$start}";
            $result = $this->store->incrementWithCeiling($name, 1, $budget, $end);
            if (!$result->ok) {
                $this->giveBack(new Reservation($key, $counters, $windowSlot));
                return new Decision(
                    Outcome::REFUSE,
                    Reason::AGENT_BUDGET_EXCEEDED,
                    Messages::budgetExceeded($key, $period, $budget, $end),
                    ['key' => $key, 'period' => $period, 'budget' => $budget, 'used' => $result->value, 'resets_at' => $end],
                );
            }
            $counters[] = ['name' => $name, 'amount' => 1];
            $evidence["{$period}_used"] = $result->value;
            $evidence["{$period}_budget"] = $budget;
        }

        $reservation = ($counters !== [] || $windowSlot !== null) ? new Reservation($key, $counters, $windowSlot) : null;
        return new Decision(Outcome::ALLOW, Reason::OK, Messages::ok(), $evidence, $reservation);
    }

    /**
     * Call after the provider accepted the send: feeds loop detection and the
     * new-recipient memory. A check alone records nothing.
     *
     * @param array<string, mixed> $send
     */
    public function record(array $send): void
    {
        $now = ($this->clock)();
        $key = $this->keyOf($send);
        $record = SendRecord::fromSend($send, $now);
        $this->store->appendSend($this->logName($key), $record, $this->loop->windowMs);
        foreach ($record->recipients as $address) {
            $this->store->incrementWithCeiling($this->seenName($key, $address), 1, null, null);
        }
    }

    /**
     * Call when the provider failed after an allow: gives back what check()
     * reserved. Releasing the same decision twice changes nothing.
     */
    public function release(Decision $decision): void
    {
        $reservation = $decision->reservation;
        if ($reservation === null || isset($this->released[$reservation])) {
            return;
        }
        $this->released[$reservation] = true;
        $this->giveBack($reservation);
    }

    /**
     * Wrap any send function. The wrapper checks, calls $send, then records
     * (or releases and rethrows when $send throws). A refusal throws
     * GuardRefused; a hold throws ApprovalRequired, whose approve() sends it
     * once a person agrees.
     *
     * @param callable $send the provider call
     * @param callable|null $toGuardSend maps the call's arguments to a send array; default: the first argument
     * @return \Closure(mixed...): mixed the provider call's result
     */
    public function wrap(callable $send, ?callable $toGuardSend = null): \Closure
    {
        $map = $toGuardSend ?? static function (mixed ...$args): array {
            $first = $args[0] ?? null;
            if (!is_array($first)) {
                throw new \InvalidArgumentException('wrap() needs a toGuardSend mapper when the first argument is not a send array.');
            }
            return $first;
        };
        $run = function (bool $approved, array $args) use ($send, $map, &$run): mixed {
            $guardSend = $map(...$args);
            if (!is_array($guardSend)) {
                throw new \InvalidArgumentException('toGuardSend must return a send array.');
            }
            $guardSend = self::stringKeys($guardSend);
            $decision = $this->check($guardSend, ['approved' => $approved]);
            if ($decision->isRefused()) {
                throw new GuardRefused($decision);
            }
            if ($decision->isHeld()) {
                throw new ApprovalRequired($decision, static fn (): mixed => $run(true, $args));
            }
            try {
                $result = $send(...$args);
            } catch (\Throwable $error) {
                $this->release($decision);
                throw $error;
            }
            $this->record($guardSend);
            return $result;
        };
        return static fn (mixed ...$args): mixed => $run(false, $args);
    }

    public function killSwitch(): KillSwitch
    {
        return $this->killSwitch;
    }

    public function store(): Store
    {
        return $this->store;
    }

    /**
     * [start, end) of the UTC calendar period containing $now (epoch ms).
     *
     * @param 'hour'|'day'|'month' $period
     * @return array{0: int, 1: int}
     */
    public static function periodBounds(string $period, int $now): array
    {
        if ($period === 'hour') {
            $start = intdiv($now, self::HOUR) * self::HOUR - ($now < 0 && $now % self::HOUR !== 0 ? self::HOUR : 0);
            return [$start, $start + self::HOUR];
        }
        if ($period === 'day') {
            $start = intdiv($now, self::DAY) * self::DAY - ($now < 0 && $now % self::DAY !== 0 ? self::DAY : 0);
            return [$start, $start + self::DAY];
        }
        $seconds = intdiv($now, 1000);
        $year = (int) gmdate('Y', $seconds);
        $month = (int) gmdate('n', $seconds);
        $start = (int) gmmktime(0, 0, 0, $month, 1, $year) * 1000;
        $end = (int) gmmktime(0, 0, 0, $month + 1, 1, $year) * 1000;
        return [$start, $end];
    }

    /** @param array<string, mixed> $send */
    private function approvalHold(array $send, SendRecord $candidate, string $key): ?Decision
    {
        $ruled = self::firstRuleMatch($candidate->recipients, $this->approvalRecipients);
        if ($ruled !== null) {
            [$recipient, $rule] = $ruled;
            return new Decision(
                Outcome::HOLD_FOR_APPROVAL,
                Reason::RECIPIENT_REQUIRES_APPROVAL,
                Messages::approvalRecipientRule($recipient, $rule),
                ['rule' => 'recipient_list', 'recipient' => $recipient, 'matched_rule' => $rule],
            );
        }
        if ($this->requireFor !== null) {
            $verdict = ($this->requireFor)($send);
            if ($verdict !== null && $verdict !== false && $verdict !== '' && $verdict !== 0) {
                return new Decision(
                    Outcome::HOLD_FOR_APPROVAL,
                    Reason::RECIPIENT_REQUIRES_APPROVAL,
                    Messages::approvalCustom(),
                    ['rule' => 'custom', 'detail' => is_string($verdict) ? $verdict : null],
                );
            }
        }
        if ($this->newRecipients) {
            $unseen = [];
            foreach ($candidate->recipients as $address) {
                if ($this->store->getCounter($this->seenName($key, $address)) === 0) {
                    $unseen[] = $address;
                }
            }
            if ($unseen !== []) {
                return new Decision(
                    Outcome::HOLD_FOR_APPROVAL,
                    Reason::RECIPIENT_REQUIRES_APPROVAL,
                    Messages::approvalNewRecipient($unseen[0], $key),
                    ['rule' => 'new_recipient', 'recipient' => $unseen[0], 'new_recipients' => implode(',', $unseen)],
                );
            }
        }
        return null;
    }

    private function giveBack(Reservation $reservation): void
    {
        foreach ($reservation->counters as $counter) {
            $this->store->decrement($counter['name'], $counter['amount']);
        }
        if ($reservation->window !== null) {
            $this->store->windowRemove($reservation->window['name'], $reservation->window['member']);
        }
    }

    /** @param array<string, mixed> $send */
    private function keyOf(array $send): string
    {
        $key = $send['key'] ?? null;
        return is_string($key) && $key !== '' ? $key : $this->defaultKey;
    }

    private function logName(string $key): string
    {
        return "{$this->namespace}:{$key}:log";
    }

    private function seenName(string $key, string $address): string
    {
        return "{$this->namespace}:{$key}:seen:{$address}";
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

    private static function nonNegative(mixed $value, string $field): int
    {
        $int = Config::int($value, $field);
        if ($int < 0) {
            throw new \InvalidArgumentException("{$field} must be 0 or more.");
        }
        return $int;
    }

    private static function matchesRule(string $address, string $rule): bool
    {
        $r = Text::normalizeAddress($rule);
        if (str_starts_with($r, '@')) {
            return str_ends_with($address, $r);
        }
        return $address === $r;
    }

    /**
     * Walk recipients in order and, for each, rules in order (SPEC §3.3).
     * Reports the normalized rule.
     *
     * @param list<string> $addresses
     * @param list<string> $rules
     * @return array{0: string, 1: string}|null
     */
    private static function firstRuleMatch(array $addresses, array $rules): ?array
    {
        if ($rules === []) {
            return null;
        }
        foreach ($addresses as $address) {
            foreach ($rules as $rule) {
                if (self::matchesRule($address, $rule)) {
                    return [$address, Text::normalizeAddress($rule)];
                }
            }
        }
        return null;
    }

    private static function newMember(int $now): string
    {
        self::$memberCounter = (self::$memberCounter + 1) % 1_000_000_000;
        return $now . '-' . self::$memberCounter . '-' . bin2hex(random_bytes(4));
    }
}
