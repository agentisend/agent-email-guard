<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

use AgentiSend\AgentEmailGuard\Store\Store;

/**
 * One call stops every send through the guard (every key sharing the store
 * and namespace) until a person resumes it. There is no timer, TTL or expiry
 * anywhere: a paused guard is still paused a year later, because an
 * automatic resume would re-arm the loop someone just stopped.
 */
final class KillSwitch
{
    /** @param \Closure(): int $clock */
    public function __construct(
        private readonly Store $store,
        private readonly string $name,
        private readonly \Closure $clock,
    ) {
    }

    /** Stop every send. Pausing again overwrites the record; the latest pause is reported. */
    public function pause(string $reason, string $by = 'agent-email-guard'): KillSwitchState
    {
        $at = ($this->clock)();
        $this->store->setState($this->name, self::encode(['paused_at' => $at, 'paused_by' => $by, 'reason' => $reason]));
        return new KillSwitchState(true, $at, $by, $reason);
    }

    /** Returns false, and records nothing, when the switch was not paused. */
    public function resume(string $by): bool
    {
        $current = $this->state();
        if (!$current->paused) {
            return false;
        }
        $this->store->setState($this->name . ':last_resume', self::encode([
            'paused_at' => $current->pausedAt,
            'paused_by' => $current->pausedBy,
            'reason' => $current->reason,
            'resumed_at' => ($this->clock)(),
            'resumed_by' => $by,
        ]));
        $this->store->setState($this->name, null);
        return true;
    }

    public function state(): KillSwitchState
    {
        $raw = $this->store->getState($this->name);
        if ($raw === null) {
            return new KillSwitchState(false);
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            // Unreadable state still means someone paused it: stay paused.
            return new KillSwitchState(true, null, null, null);
        }
        return new KillSwitchState(
            true,
            is_numeric($data['paused_at'] ?? null) ? (int) $data['paused_at'] : null,
            is_string($data['paused_by'] ?? null) ? $data['paused_by'] : null,
            is_string($data['reason'] ?? null) ? $data['reason'] : null,
        );
    }

    /** @param array<string, mixed> $data */
    private static function encode(array $data): string
    {
        return json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
