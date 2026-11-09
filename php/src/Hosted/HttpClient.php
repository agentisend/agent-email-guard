<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

/** The one HTTP call the hosted adapter makes. Bring your own (Guzzle, Symfony HttpClient) or use CurlHttpClient. */
interface HttpClient
{
    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     */
    public function request(string $method, string $url, array $headers, ?string $body): array;
}
