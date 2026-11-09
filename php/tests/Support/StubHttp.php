<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Support;

use AgentiSend\AgentEmailGuard\Hosted\HttpClient;

/** Records every request and answers from a queue. */
final class StubHttp implements HttpClient
{
    /** @var list<array{method: string, url: string, headers: array<string, string>, body: array<array-key, mixed>|null}> */
    public array $requests = [];

    /** @param list<array{status: int, body: array<string, mixed>}> $responses */
    public function __construct(private array $responses)
    {
    }

    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        $decoded = $body === null ? null : json_decode($body, true);
        $this->requests[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => is_array($decoded) ? $decoded : null];
        $next = array_shift($this->responses);
        if ($next === null) {
            throw new \LogicException("No stub response left for {$method} {$url}");
        }
        return ['status' => $next['status'], 'body' => json_encode($next['body'], JSON_THROW_ON_ERROR)];
    }
}
