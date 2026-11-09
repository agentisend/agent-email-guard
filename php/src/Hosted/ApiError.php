<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

/** An AgentiSend API error that is not a guard decision (bad key, unverified domain, invalid request). */
final class ApiError extends \RuntimeException
{
    /** @param array<string, mixed> $body */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?string $fix = null,
        public readonly array $body = [],
    ) {
        parent::__construct($message);
    }
}
