<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * One verdict on one send (SPEC §2.3): an outcome, a stable reason token, one
 * human sentence ending in a period, and the numbers behind it.
 */
final class Decision implements \JsonSerializable
{
    /**
     * @param string $outcome One of Outcome::ALL.
     * @param string $reason One of Reason::TOKENS.
     * @param array<string, string|int|float|bool|null> $evidence
     */
    public function __construct(
        public readonly string $outcome,
        public readonly string $reason,
        public readonly string $message,
        public readonly array $evidence,
        public readonly ?Reservation $reservation = null,
    ) {
    }

    public function isAllowed(): bool
    {
        return $this->outcome === Outcome::ALLOW;
    }

    public function isHeld(): bool
    {
        return $this->outcome === Outcome::HOLD_FOR_APPROVAL;
    }

    public function isRefused(): bool
    {
        return $this->outcome === Outcome::REFUSE;
    }

    /** The contract every decision meets: a known token, a sentence, evidence, ok exactly on allow. */
    public function isValid(): bool
    {
        if (!in_array($this->reason, Reason::TOKENS, true)) {
            return false;
        }
        if (!in_array($this->outcome, Outcome::ALL, true)) {
            return false;
        }
        $message = trim($this->message);
        if (strlen($message) < 8 || !str_ends_with($message, '.')) {
            return false;
        }
        return ($this->reason === Reason::OK) === ($this->outcome === Outcome::ALLOW);
    }

    /**
     * @return array{outcome: string, reason: string, message: string, evidence: array<string, string|int|float|bool|null>, reservation?: array{key: string, counters: list<array{name: string, amount: int}>, window: array{name: string, member: string}|null}}
     */
    public function toArray(): array
    {
        $out = [
            'outcome' => $this->outcome,
            'reason' => $this->reason,
            'message' => $this->message,
            'evidence' => $this->evidence,
        ];
        if ($this->reservation !== null) {
            $out['reservation'] = $this->reservation->toArray();
        }
        return $out;
    }

    /**
     * @param array{outcome: string, reason: string, message: string, evidence: array<string, string|int|float|bool|null>, reservation?: array{key: string, counters: list<array{name: string, amount: int}>, window: array{name: string, member: string}|null}|null} $data
     */
    public static function fromArray(array $data): self
    {
        $reservation = isset($data['reservation']) ? Reservation::fromArray($data['reservation']) : null;
        return new self($data['outcome'], $data['reason'], $data['message'], $data['evidence'], $reservation);
    }

    /** @return array<string, mixed> */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
