<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Symfony;

use AgentiSend\AgentEmailGuard\ApprovalRequired;
use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\GuardRefused;
use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\TransportInterface;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Symfony\Component\Mime\Message;
use Symfony\Component\Mime\RawMessage;

/**
 * Puts agent-email-guard in front of any Symfony Mailer transport: SMTP, SES,
 * Postmark, Resend, AgentiSend, or a Laravel mailer (Laravel's transports are
 * Symfony transports).
 *
 *   $transport = new GuardedTransport($guard, Transport::fromDsn($dsn));
 *   $mailer = new Mailer($transport);
 *
 * A refused message throws GuardRefused and never reaches the inner
 * transport; a held one throws ApprovalRequired, whose approve() sends it.
 * Set the X-Agent-Email-Guard-Key header on a message to count it against a
 * specific key (the header is removed before the message is sent).
 */
final class GuardedTransport implements TransportInterface
{
    public const KEY_HEADER = 'X-Agent-Email-Guard-Key';

    public function __construct(
        private readonly Guard $guard,
        private readonly TransportInterface $inner,
        private readonly ?string $key = null,
    ) {
    }

    /**
     * @throws GuardRefused when the guard refuses the message
     * @throws ApprovalRequired when a person has to approve it first
     */
    public function send(RawMessage $message, ?Envelope $envelope = null): ?SentMessage
    {
        $key = $this->key;
        if ($message instanceof Message && $message->getHeaders()->has(self::KEY_HEADER)) {
            $key = $message->getHeaders()->get(self::KEY_HEADER)?->getBodyAsString() ?: $key;
            $message->getHeaders()->remove(self::KEY_HEADER);
        }
        return $this->deliver($message, $envelope, self::toGuardSend($message, $envelope, $key), false);
    }

    /** @param array<string, mixed> $send */
    private function deliver(RawMessage $message, ?Envelope $envelope, array $send, bool $approved): ?SentMessage
    {
        $decision = $this->guard->check($send, ['approved' => $approved]);
        if ($decision->isRefused()) {
            throw new GuardRefused($decision);
        }
        if ($decision->isHeld()) {
            throw new ApprovalRequired($decision, fn (): ?SentMessage => $this->deliver($message, $envelope, $send, true));
        }
        try {
            $sent = $this->inner->send($message, $envelope);
        } catch (\Throwable $error) {
            $this->guard->release($decision);
            throw $error;
        }
        $this->guard->record($send);
        return $sent;
    }

    /**
     * The guard's view of a Symfony message.
     *
     * @return array<string, mixed>
     */
    public static function toGuardSend(RawMessage $message, ?Envelope $envelope = null, ?string $key = null): array
    {
        $send = [];
        if ($key !== null && $key !== '') {
            $send['key'] = $key;
        }
        if ($message instanceof Email) {
            $send['to'] = self::addresses($message->getTo());
            $send['cc'] = self::addresses($message->getCc());
            $send['bcc'] = self::addresses($message->getBcc());
            $send['subject'] = $message->getSubject() ?? '';
            $text = self::body($message->getTextBody());
            $html = self::body($message->getHtmlBody());
            if ($text !== null) {
                $send['text'] = $text;
            }
            if ($html !== null) {
                $send['html'] = $html;
            }
        } elseif ($message instanceof Message) {
            $headers = $message->getHeaders();
            foreach (['to' => 'To', 'cc' => 'Cc', 'bcc' => 'Bcc'] as $field => $name) {
                $header = $headers->get($name);
                $send[$field] = $header === null ? [] : $header->getBodyAsString();
            }
            $send['subject'] = $headers->get('Subject')?->getBodyAsString() ?? '';
            $send['text'] = $message->getBody()?->bodyToString() ?? '';
        }
        if ($envelope !== null && ($send['to'] ?? []) === [] && ($send['cc'] ?? []) === [] && ($send['bcc'] ?? []) === []) {
            $send['to'] = self::addresses($envelope->getRecipients());
        }
        $send['to'] ??= [];
        return $send;
    }

    public function __toString(): string
    {
        return 'agent-email-guard(' . $this->inner . ')';
    }

    /**
     * @param array<Address> $addresses
     * @return list<string>
     */
    private static function addresses(array $addresses): array
    {
        return array_values(array_map(static fn (Address $a): string => $a->getAddress(), $addresses));
    }

    /** @param resource|string|null $body */
    private static function body(mixed $body): ?string
    {
        if (is_string($body) || $body === null) {
            return $body;
        }
        $contents = stream_get_contents($body);
        if (stream_get_meta_data($body)['seekable']) {
            rewind($body);
        }
        return $contents === false ? null : $contents;
    }
}
