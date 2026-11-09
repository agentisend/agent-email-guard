<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * One accepted send, as loop detection compares it (SPEC §6.1). Text fields
 * are already normalized. toArray() uses the snake_case keys every language
 * writes, so processes in different languages can share one store.
 */
final class SendRecord
{
    /** @param list<string> $recipients */
    public function __construct(
        /** Sorted, comma-joined To addresses. Repetition compares this. */
        public readonly string $toLine,
        /** Every address the send reached (To, Cc, Bcc). Entropy counts these. */
        public readonly array $recipients,
        public readonly string $subject,
        public readonly string $body,
        /** Epoch ms. */
        public readonly int $at,
    ) {
    }

    /**
     * The parts of a send the guard compares (SPEC §3).
     *
     * @param array<string, mixed> $send
     */
    public static function fromSend(array $send, int $at): self
    {
        $to = Text::addressList($send['to'] ?? null);
        $recipients = $to;
        $seen = array_fill_keys($to, true);
        foreach ([...Text::addressList($send['cc'] ?? null), ...Text::addressList($send['bcc'] ?? null)] as $address) {
            if (!isset($seen[$address])) {
                $seen[$address] = true;
                $recipients[] = $address;
            }
        }
        $sorted = $to;
        sort($sorted, SORT_STRING);
        $subject = isset($send['subject']) && is_string($send['subject']) ? $send['subject'] : '';
        // SPEC §2.2: the body is text when it is a non-empty string, else html, else "".
        if (isset($send['text']) && is_string($send['text']) && $send['text'] !== '') {
            $body = $send['text'];
        } elseif (isset($send['html']) && is_string($send['html'])) {
            $body = $send['html'];
        } else {
            $body = '';
        }
        return new self(
            implode(',', $sorted),
            $recipients,
            Text::normalizeText($subject),
            substr(Text::normalizeText($body), 0, Text::BODY_COMPARE_CHARS),
            $at,
        );
    }

    /** @return array{to_line: string, recipients: list<string>, subject: string, body: string, at: int} */
    public function toArray(): array
    {
        return [
            'to_line' => $this->toLine,
            'recipients' => $this->recipients,
            'subject' => $this->subject,
            'body' => $this->body,
            'at' => $this->at,
        ];
    }

    /** @param array<array-key, mixed> $data */
    public static function fromArray(array $data): self
    {
        $recipients = [];
        foreach (is_array($data['recipients'] ?? null) ? $data['recipients'] : [] as $r) {
            if (is_string($r)) {
                $recipients[] = $r;
            }
        }
        return new self(
            is_string($data['to_line'] ?? null) ? $data['to_line'] : '',
            $recipients,
            is_string($data['subject'] ?? null) ? $data['subject'] : '',
            is_string($data['body'] ?? null) ? $data['body'] : '',
            is_numeric($data['at'] ?? null) ? (int) $data['at'] : 0,
        );
    }

    public function toJson(): string
    {
        return json_encode($this->toArray(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    public static function fromJson(string $json): self
    {
        $data = json_decode($json, true, 16, JSON_THROW_ON_ERROR);
        return self::fromArray(is_array($data) ? $data : []);
    }
}
