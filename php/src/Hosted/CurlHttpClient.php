<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

/** HttpClient on ext-curl. */
final class CurlHttpClient implements HttpClient
{
    public function __construct(private readonly int $timeoutSeconds = 30)
    {
    }

    public function request(string $method, string $url, array $headers, ?string $body): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('CurlHttpClient needs ext-curl; pass another HttpClient to AgentiSendGuard instead.');
        }
        if ($method === '') {
            throw new \InvalidArgumentException('method must not be empty.');
        }
        $handle = curl_init($url);
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = "{$name}: {$value}";
        }
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
        ]);
        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($handle);
        if (!is_string($response)) {
            $error = curl_error($handle);
            curl_close($handle);
            throw new \RuntimeException("Could not reach AgentiSend: {$error}");
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        return ['status' => $status, 'body' => $response];
    }
}
