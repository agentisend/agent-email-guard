<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Support;

use Resend\Contracts\Transporter;
use Resend\ValueObjects\Transporter\Payload;

/** Answers Resend SDK calls in memory. */
final class FakeResendTransporter implements Transporter
{
    /** @var list<Payload> */
    public array $payloads = [];

    public function request(Payload $payload): array
    {
        $this->payloads[] = $payload;
        return ['id' => 're_' . count($this->payloads)];
    }
}
