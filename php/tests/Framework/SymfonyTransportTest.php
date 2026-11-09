<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Framework;

use AgentiSend\AgentEmailGuard\ApprovalRequired;
use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\GuardRefused;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\Symfony\GuardedTransport;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mailer\Mailer;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\AbstractTransport;
use Symfony\Component\Mime\Email;
use Symfony\Component\Mime\RawMessage;

#[Group('framework')]
final class SymfonyTransportTest extends TestCase
{
    private static function email(string $to = 'user@example.com', string $subject = 'Welcome'): Email
    {
        return (new Email())->from('agent@example.com')->to($to)->subject($subject)->text('Hello there.');
    }

    public function testAnAllowedMessageReachesTheInnerTransportAndIsRecorded(): void
    {
        $inner = new RecordingTransport();
        $guard = Guard::create(['budgets' => ['perHour' => 1]]);
        $mailer = new Mailer(new GuardedTransport($guard, $inner));
        $mailer->send(self::email());
        self::assertCount(1, $inner->sent);
        $this->expectException(GuardRefused::class);
        $mailer->send(self::email('other@example.com'));
    }

    public function testARefusedMessageNeverReachesTheInnerTransport(): void
    {
        $inner = new RecordingTransport();
        $transport = new GuardedTransport(Guard::create(['suppress' => ['@blocked.example']]), $inner);
        try {
            $transport->send(self::email('ceo@blocked.example'));
            self::fail('not refused');
        } catch (GuardRefused $e) {
            self::assertSame(Reason::RECIPIENT_SUPPRESSED, $e->reason);
        }
        self::assertSame([], $inner->sent);
    }

    public function testAHeldMessageSendsWhenApproved(): void
    {
        $inner = new RecordingTransport();
        $transport = new GuardedTransport(Guard::create(['approval' => ['recipients' => ['vip@bigco.com']]]), $inner);
        try {
            $transport->send(self::email('vip@bigco.com'));
            self::fail('not held');
        } catch (ApprovalRequired $held) {
            self::assertSame([], $inner->sent);
            self::assertInstanceOf(SentMessage::class, $held->approve());
            self::assertCount(1, $inner->sent);
        }
    }

    public function testTheKeyHeaderPicksTheKeyAndIsRemovedBeforeSending(): void
    {
        $inner = new RecordingTransport();
        $guard = Guard::create(['budgets' => ['perDay' => 1]]);
        $transport = new GuardedTransport($guard, $inner);
        $first = self::email();
        $first->getHeaders()->addTextHeader(GuardedTransport::KEY_HEADER, 'billing-agent');
        $transport->send($first);
        $second = self::email('b@example.com');
        $second->getHeaders()->addTextHeader(GuardedTransport::KEY_HEADER, 'support-agent');
        $transport->send($second);
        self::assertCount(2, $inner->sent);
        self::assertFalse($inner->sent[0]->getHeaders()->has(GuardedTransport::KEY_HEADER));
    }

    public function testAFailedSendGivesTheBudgetBack(): void
    {
        $inner = new RecordingTransport(fail: true);
        $guard = Guard::create(['budgets' => ['perHour' => 1]]);
        $transport = new GuardedTransport($guard, $inner);
        try {
            $transport->send(self::email());
        } catch (\RuntimeException $e) {
            self::assertSame('provider down', $e->getMessage());
        }
        self::assertTrue($guard->check(['to' => 'x@example.com'])->isAllowed());
    }

    public function testToGuardSendReadsEveryRecipientAndBothBodies(): void
    {
        $email = self::email()->cc('Cc Person <cc@example.com>')->bcc('bcc@example.com')->html('<p>Hi</p>');
        $send = GuardedTransport::toGuardSend($email, null, 'k');
        self::assertSame(['user@example.com'], $send['to']);
        self::assertSame(['cc@example.com'], $send['cc']);
        self::assertSame(['bcc@example.com'], $send['bcc']);
        self::assertSame('Hello there.', $send['text']);
        self::assertSame('<p>Hi</p>', $send['html']);
        self::assertSame('k', $send['key']);
    }
}

/** An inner transport that keeps what it was given. */
final class RecordingTransport extends AbstractTransport
{
    /** @var list<Email> */
    public array $sent = [];

    public function __construct(private readonly bool $fail = false)
    {
        parent::__construct();
    }

    public function send(RawMessage $message, ?Envelope $envelope = null): ?SentMessage
    {
        if ($this->fail) {
            throw new \RuntimeException('provider down');
        }
        return parent::send($message, $envelope);
    }

    protected function doSend(SentMessage $message): void
    {
        $original = $message->getOriginalMessage();
        if ($original instanceof Email) {
            $this->sent[] = $original;
        }
    }

    public function __toString(): string
    {
        return 'recording://';
    }
}
