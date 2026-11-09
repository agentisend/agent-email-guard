<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * What check() reserved, so release() can give it back. Serializable with
 * toArray()/fromArray() so a decision can cross a process boundary.
 */
final class Reservation
{
    /**
     * @param list<array{name: string, amount: int}> $counters
     * @param array{name: string, member: string}|null $window
     */
    public function __construct(
        public readonly string $key,
        public readonly array $counters,
        public readonly ?array $window,
    ) {
    }

    /** @return array{key: string, counters: list<array{name: string, amount: int}>, window: array{name: string, member: string}|null} */
    public function toArray(): array
    {
        return ['key' => $this->key, 'counters' => $this->counters, 'window' => $this->window];
    }

    /** @param array{key: string, counters: list<array{name: string, amount: int}>, window: array{name: string, member: string}|null} $data */
    public static function fromArray(array $data): self
    {
        return new self($data['key'], $data['counters'], $data['window']);
    }
}
