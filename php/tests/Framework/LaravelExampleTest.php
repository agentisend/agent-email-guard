<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Framework;

use AgentiSend\AgentEmailGuard\Laravel\AgentEmailGuardServiceProvider;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Mail\Mailer;
use Illuminate\Mail\Transport\ArrayTransport;
use Illuminate\Support\Facades\Mail;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\Group;

use function AgentiSend\AgentEmailGuard\Examples\agentSendsOrderUpdate;

require_once dirname(__DIR__, 2) . '/examples/laravel.php';

/** examples/laravel.php, with a guarded mailer that wraps Laravel's array mailer. */
#[Group('framework')]
final class LaravelExampleTest extends TestCase
{
    protected function getPackageProviders($app): array
    {
        return [AgentEmailGuardServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app->make(Repository::class)->set('mail.mailers.array', ['transport' => 'array']);
        $app->make(Repository::class)->set('mail.mailers.guarded', ['transport' => 'agent-email-guard', 'mailer' => 'array', 'key' => 'support-agent']);
        $app->make(Repository::class)->set('mail.from', ['address' => 'agent@example.com', 'name' => 'Agent']);
        $app->make(Repository::class)->set('agent-email-guard.rate.per_minute', 1);
        $app->make(Repository::class)->set('agent-email-guard.approval.recipients', ['@bigcustomer.com']);
    }

    public function testTheExampleSendsRefusesAndHolds(): void
    {
        self::assertSame('sent', agentSendsOrderUpdate('a@example.com', '1042'));
        self::assertStringStartsWith('refused (rate_ceiling_exceeded): Key "support-agent" reached its ceiling of 1 send per minute', agentSendsOrderUpdate('b@example.com', '1043'));
        self::assertStringStartsWith('held: ceo@bigcustomer.com matches the approval rule @bigcustomer.com', agentSendsOrderUpdate('ceo@bigcustomer.com', '1044'));
        $mailer = Mail::mailer('array');
        self::assertInstanceOf(\Illuminate\Mail\Mailer::class, $mailer);
        $transport = $mailer->getSymfonyTransport();
        self::assertInstanceOf(ArrayTransport::class, $transport);
        self::assertCount(1, $transport->messages());
    }
}
