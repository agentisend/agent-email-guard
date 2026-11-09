<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

use AgentiSend\AgentEmailGuard\SendRecord;

/**
 * The store contract (SPEC §6). Every backend (memory, Redis, PDO, your own)
 * implements exactly this.
 *
 * The one rule that matters: incrementWithCeiling() and windowAdd() are each
 * ONE atomic step. Read-then-write is the bug this package exists to prevent:
 * two processes racing at used = budget - 1 must not both get through.
 */
interface Store
{
    /** The send log keeps at most this many entries per key. */
    public const SEND_LOG_CAP = 10_000;

    /**
     * Atomically: if value + amount <= ceiling (or ceiling is null), add amount
     * and return ok with the new value; otherwise change nothing and return
     * not-ok with the current value. A missing counter is 0. $expiresAt (epoch
     * ms, or null for never) lets the backend drop the counter afterwards.
     */
    public function incrementWithCeiling(string $name, int $amount, ?int $ceiling, ?int $expiresAt): CounterResult;

    /** Subtract amount, never below 0. A missing counter is a no-op. */
    public function decrement(string $name, int $amount): void;

    public function getCounter(string $name): int;

    /**
     * Sliding window, atomically: drop members with at - memberAt >= windowMs;
     * if the remaining count < ceiling, add (member, at) and return ok.
     */
    public function windowAdd(string $name, string $member, int $at, int $windowMs, int $ceiling): WindowResult;

    public function windowRemove(string $name, string $member): void;

    /** Append to a key's send log. Entries older than $keepMs before $record->at may be dropped. */
    public function appendSend(string $log, SendRecord $record, int $keepMs): void;

    /**
     * Every logged send with at >= $since, oldest first.
     *
     * @return list<SendRecord>
     */
    public function recentSends(string $log, int $since): array;

    public function getState(string $name): ?string;

    /** Null deletes. */
    public function setState(string $name, ?string $value): void;
}
