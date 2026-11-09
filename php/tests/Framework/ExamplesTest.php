<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Framework;

use AgentiSend\Client as AgentiSendClient;
use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\GuardRefused;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\Tests\Support\FakeResendTransporter;
use PHPMailer\PHPMailer\PHPMailer;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Mailer\Transport\NullTransport;
use Symfony\Component\Mime\Email;

use function AgentiSend\AgentEmailGuard\Examples\guardedMailer;
use function AgentiSend\AgentEmailGuard\Examples\sendWithAgentiSend;
use function AgentiSend\AgentEmailGuard\Examples\sendWithPhpMailer;
use function AgentiSend\AgentEmailGuard\Examples\sendWithResend;

require_once dirname(__DIR__, 2) . '/examples/agentisend-sdk.php';
require_once dirname(__DIR__, 2) . '/examples/resend-php.php';
require_once dirname(__DIR__, 2) . '/examples/phpmailer.php';
require_once dirname(__DIR__, 2) . '/examples/symfony-mailer.php';

/** Every example runs against a stub of its provider; nothing leaves the machine. */
#[Group('framework')]
final class ExamplesTest extends TestCase
{
    public function testAgentiSendSdkExample(): void
    {
        $client = new class ('as_test', 'https://api.example.test') extends AgentiSendClient {
            /** @var list<array{string, string, array<string, mixed>|null}> */
            public array $calls = [];

            public function request(string $method, string $path, ?array $body = null, ?array $query = null, ?string $idempotencyKey = null): array
            {
                $this->calls[] = [$method, $path, $body];
                return ['id' => 'msg_' . count($this->calls)];
            }
        };
        $guard = Guard::create(['budgets' => ['perHour' => 1]]);
        $email = ['from' => 'a@yourdomain.com', 'to' => 'b@example.com', 'subject' => 'Hi', 'text' => 'Hello.'];
        self::assertSame(['id' => 'msg_1'], sendWithAgentiSend($guard, $client, $email));
        self::assertSame('/emails', $client->calls[0][1]);
        $this->expectException(GuardRefused::class);
        sendWithAgentiSend($guard, $client, $email);
    }

    public function testResendPhpExample(): void
    {
        $transporter = new FakeResendTransporter();
        $guard = Guard::create(['suppress' => ['@blocked.example']]);
        $resend = new \Resend\Client($transporter);
        $id = sendWithResend($guard, $resend, ['from' => 'a@yourdomain.com', 'to' => 'b@example.com', 'subject' => 'Hi', 'html' => '<p>Hi</p>']);
        self::assertSame('re_1', $id);
        self::assertCount(1, $transporter->payloads);
        try {
            sendWithResend($guard, $resend, ['from' => 'a@yourdomain.com', 'to' => 'x@blocked.example', 'subject' => 'Hi', 'html' => '<p>Hi</p>']);
            self::fail('not refused');
        } catch (GuardRefused $e) {
            self::assertSame(Reason::RECIPIENT_SUPPRESSED, $e->reason);
        }
        self::assertCount(1, $transporter->payloads);
    }

    public function testPhpMailerExample(): void
    {
        $mail = new class (true) extends PHPMailer {
            public int $sent = 0;

            public function send(): bool
            {
                $this->sent++;
                return true;
            }
        };
        $guard = Guard::create(['rate' => ['perMinute' => 1]]);
        sendWithPhpMailer($guard, $mail, 'b@example.com', 'Hi', 'Hello.');
        self::assertSame(1, $mail->sent);
        $this->expectException(GuardRefused::class);
        sendWithPhpMailer($guard, $mail, 'c@example.com', 'Hi', 'Hello.');
    }

    public function testSymfonyMailerExample(): void
    {
        $guard = Guard::create(['budgets' => ['perDay' => 1]]);
        $mailer = guardedMailer($guard, new NullTransport());
        $email = (new Email())->from('a@yourdomain.com')->to('b@example.com')->subject('Hi')->text('Hello.');
        $mailer->send($email);
        $this->expectException(GuardRefused::class);
        $mailer->send((new Email())->from('a@yourdomain.com')->to('c@example.com')->subject('Hi')->text('Hello.'));
    }
}
