<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

use AgentiSend\AgentEmailGuard\SendRecord;

/**
 * The default store: one PHP process, nothing shared. Under PHP-FPM every
 * request gets a fresh one, so budgets and the kill switch reset per request.
 * Use RedisStore or PdoStore for anything that must hold across requests,
 * workers or servers.
 */
final class MemoryStore implements Store
{
    /** @var array<string, array{value: int, expiresAt: int|null}> */
    private array $counters = [];
    /** @var array<string, array<string, int>> */
    private array $windows = [];
    /** @var array<string, list<SendRecord>> */
    private array $logs = [];
    /** @var array<string, string> */
    private array $state = [];

    public function incrementWithCeiling(string $name, int $amount, ?int $ceiling, ?int $expiresAt): CounterResult
    {
        $current = $this->counters[$name]['value'] ?? 0;
        if ($ceiling !== null && $current + $amount > $ceiling) {
            return new CounterResult(false, $current);
        }
        $this->counters[$name] = ['value' => $current + $amount, 'expiresAt' => $expiresAt];
        return new CounterResult(true, $current + $amount);
    }

    public function decrement(string $name, int $amount): void
    {
        if (!isset($this->counters[$name])) {
            return;
        }
        $this->counters[$name]['value'] = max(0, $this->counters[$name]['value'] - $amount);
    }

    public function getCounter(string $name): int
    {
        return $this->counters[$name]['value'] ?? 0;
    }

    public function windowAdd(string $name, string $member, int $at, int $windowMs, int $ceiling): WindowResult
    {
        $window = $this->windows[$name] ?? [];
        foreach ($window as $m => $t) {
            if ($at - $t >= $windowMs) {
                unset($window[$m]);
            }
        }
        $oldest = $window === [] ? null : min($window);
        if (count($window) >= $ceiling) {
            $this->windows[$name] = $window;
            return new WindowResult(false, count($window), $oldest);
        }
        $window[$member] = $at;
        $this->windows[$name] = $window;
        return new WindowResult(true, count($window), $oldest ?? $at);
    }

    public function windowRemove(string $name, string $member): void
    {
        unset($this->windows[$name][$member]);
    }

    public function appendSend(string $log, SendRecord $record, int $keepMs): void
    {
        $list = $this->logs[$log] ?? [];
        $list[] = $record;
        $drop = 0;
        $n = count($list);
        while ($drop < $n && $record->at - $list[$drop]->at > $keepMs) {
            $drop++;
        }
        if ($n - $drop > self::SEND_LOG_CAP) {
            $drop = $n - self::SEND_LOG_CAP;
        }
        $this->logs[$log] = $drop > 0 ? array_slice($list, $drop) : $list;
    }

    public function recentSends(string $log, int $since): array
    {
        $out = [];
        foreach ($this->logs[$log] ?? [] as $record) {
            if ($record->at >= $since) {
                $out[] = $record;
            }
        }
        return $out;
    }

    public function getState(string $name): ?string
    {
        return $this->state[$name] ?? null;
    }

    public function setState(string $name, ?string $value): void
    {
        if ($value === null) {
            unset($this->state[$name]);
        } else {
            $this->state[$name] = $value;
        }
    }
}
