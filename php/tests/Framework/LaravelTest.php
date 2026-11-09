<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Framework;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\GuardRefused;
use AgentiSend\AgentEmailGuard\Laravel\AgentEmailGuardServiceProvider;
use AgentiSend\AgentEmailGuard\Laravel\Facades\AgentEmailGuard;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\Store\PdoStore;
use AgentiSend\AgentEmailGuard\Store\Store;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Mail\Message;
use Illuminate\Mail\Transport\ArrayTransport;
use Illuminate\Support\Facades\Mail;
use Orchestra\Testbench\TestCase;
use PHPUnit\Framework\Attributes\Group;

#[Group('framework')]
final class LaravelTest extends TestCase
{
    protected function getPackageProviders($app): array
    {
        return [AgentEmailGuardServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app->make(Repository::class)->set('mail.default', 'guarded');
        $app->make(Repository::class)->set('mail.mailers.array', ['transport' => 'array']);
        $app->make(Repository::class)->set('mail.mailers.guarded', ['transport' => 'agent-email-guard', 'mailer' => 'array', 'key' => 'support-agent']);
        $app->make(Repository::class)->set('mail.from', ['address' => 'agent@example.com', 'name' => 'Agent']);
        $app->make(Repository::class)->set('agent-email-guard.budgets.per_hour', '2');
        $app->make(Repository::class)->set('agent-email-guard.suppress', ['@blocked.example']);
    }

    private function arrayTransport(): ArrayTransport
    {
        $mailer = Mail::mailer('array');
        self::assertInstanceOf(\Illuminate\Mail\Mailer::class, $mailer);
        $transport = $mailer->getSymfonyTransport();
        self::assertInstanceOf(ArrayTransport::class, $transport);
        return $transport;
    }

    public function testTheGuardedMailerSendsThroughTheWrappedMailerUntilTheBudgetIsSpent(): void
    {
        Mail::raw('Hello one.', static fn (Message $m) => $m->to('a@example.com')->subject('One'));
        Mail::raw('Hello two.', static fn (Message $m) => $m->to('b@example.com')->subject('Two'));
        self::assertCount(2, $this->arrayTransport()->messages());

        try {
            Mail::raw('Hello three.', static fn (Message $m) => $m->to('c@example.com')->subject('Three'));
            self::fail('the third send was not refused');
        } catch (GuardRefused $e) {
            self::assertSame(Reason::AGENT_BUDGET_EXCEEDED, $e->reason);
            self::assertSame('support-agent', $e->decision->evidence['key']);
        }
        self::assertCount(2, $this->arrayTransport()->messages());
    }

    public function testSuppressionFromConfigRefuses(): void
    {
        $this->expectException(GuardRefused::class);
        Mail::raw('Hi.', static fn (Message $m) => $m->to('ceo@blocked.example')->subject('Hi'));
    }

    public function testTheFacadeAndContainerShareOneGuard(): void
    {
        self::assertNotNull($this->app);
        self::assertSame($this->app->make(Guard::class), AgentEmailGuard::getFacadeRoot());
        self::assertTrue(AgentEmailGuard::check(['to' => 'x@example.com'])->isAllowed());
    }

    public function testTheDatabaseStoreUsesTheMigratedTables(): void
    {
        $app = $this->app;
        self::assertNotNull($app);
        $config = $app->make(Repository::class);
        $config->set('database.default', 'testing');
        $config->set('database.connections.testing', ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
        $config->set('agent-email-guard.store.driver', 'database');
        $app->forgetInstance(Store::class);
        $app->forgetInstance(Guard::class);
        $this->loadMigrationsFrom(dirname(__DIR__, 2) . '/database/migrations');

        $store = $app->make(Store::class);
        self::assertInstanceOf(PdoStore::class, $store);
        $guard = $app->make(Guard::class);
        self::assertTrue($guard->check(['to' => 'a@example.com'])->isAllowed());
        self::assertTrue($guard->check(['to' => 'b@example.com'])->isAllowed());
        self::assertSame(Reason::AGENT_BUDGET_EXCEEDED, $guard->check(['to' => 'c@example.com'])->reason);
    }
}
