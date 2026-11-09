<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Outcome;
use AgentiSend\AgentEmailGuard\Reason;
use AgentiSend\AgentEmailGuard\Store\PdoStore;
use AgentiSend\AgentEmailGuard\Store\RedisStore;
use AgentiSend\AgentEmailGuard\Store\Store;
use PHPUnit\Framework\TestCase;

/**
 * Port of packages/agent-guard/test/b08-budget-race.test.ts. PHP has no
 * in-process concurrency, so the race is real: forked processes, each with
 * its own database connection, against one SQLite file (SPEC §9: 200
 * concurrent checks against a budget of 50 allow exactly 50).
 */
final class BudgetRaceTest extends TestCase
{
    private const NOW = 1_800_000_000_000;
    private const SEND = ['to' => 'a@example.com', 'subject' => 's', 'text' => 'b'];

    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/agent-guard-race-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
    }

    private function sqliteStore(): PdoStore
    {
        $pdo = new \PDO('sqlite:' . $this->dir . '/guard.sqlite');
        $pdo->setAttribute(\PDO::ATTR_TIMEOUT, 30);
        return new PdoStore($pdo);
    }

    /**
     * Run $total checks spread over $workers forked processes; return how many were allowed.
     *
     * @param array<string, mixed> $config
     * @param (\Closure(): Store)|null $storeFactory called inside each worker, so every worker has its own connection
     */
    private function race(array $config, int $workers, int $perWorker, ?\Closure $storeFactory = null): int
    {
        if (!function_exists('pcntl_fork')) {
            self::markTestSkipped('The race needs the pcntl extension (CLI on Linux or macOS).');
        }
        if ($storeFactory === null) {
            $this->sqliteStore()->createSchema();
            $storeFactory = fn (): Store => $this->sqliteStore();
        }
        $pids = [];
        for ($w = 0; $w < $workers; $w++) {
            $pid = pcntl_fork();
            if ($pid === -1) {
                self::fail('fork failed');
            }
            if ($pid === 0) {
                $allowed = 0;
                try {
                    $guard = Guard::create(['store' => $storeFactory(), 'clock' => static fn (): int => self::NOW] + $config);
                    for ($i = 0; $i < $perWorker; $i++) {
                        if ($guard->check(self::SEND)->outcome === Outcome::ALLOW) {
                            $allowed++;
                        }
                    }
                    file_put_contents("{$this->dir}/worker-{$w}", (string) $allowed);
                    exit(0);
                } catch (\Throwable $e) {
                    file_put_contents("{$this->dir}/worker-{$w}", 'error: ' . $e->getMessage());
                    exit(1);
                }
            }
            $pids[] = $pid;
        }
        foreach ($pids as $pid) {
            pcntl_waitpid($pid, $status);
        }
        $total = 0;
        for ($w = 0; $w < $workers; $w++) {
            $out = (string) file_get_contents("{$this->dir}/worker-{$w}");
            self::assertMatchesRegularExpression('/^\d+$/', $out, "worker {$w}: {$out}");
            $total += (int) $out;
        }
        return $total;
    }

    public function test200ConcurrentChecksAgainstABudgetOf50AllowExactly50(): void
    {
        $allowed = $this->race(['budgets' => ['perDay' => 50], 'loop' => ['mode' => 'off']], 20, 10);
        self::assertSame(50, $allowed);
        $counter = $this->sqliteStore()->getCounter('agent-email-guard:default:budget:day:' . Guard::periodBounds('day', self::NOW)[0]);
        self::assertSame(50, $counter);
    }

    public function testTheRaceHoldsOnPostgres(): void
    {
        $dsn = getenv('AGENT_GUARD_PG_DSN');
        if (!is_string($dsn) || $dsn === '') {
            self::markTestSkipped('Set AGENT_GUARD_PG_DSN to race on Postgres.');
        }
        $user = getenv('AGENT_GUARD_PG_USER');
        $password = getenv('AGENT_GUARD_PG_PASSWORD');
        $connect = static fn (): \PDO => new \PDO($dsn, is_string($user) ? $user : null, is_string($password) ? $password : null);
        $schema = 'agent_guard_race_' . bin2hex(random_bytes(4));
        $admin = $connect();
        $admin->exec("CREATE SCHEMA {$schema}");
        try {
            $admin->exec("SET search_path TO {$schema}");
            (new PdoStore($admin))->createSchema();
            $factory = static function () use ($connect, $schema): Store {
                $pdo = $connect();
                $pdo->exec("SET search_path TO {$schema}");
                return new PdoStore($pdo);
            };
            self::assertSame(50, $this->race(['budgets' => ['perDay' => 50], 'rate' => ['perMinute' => 120], 'loop' => ['mode' => 'off']], 20, 10, $factory));
            self::assertSame(30, $this->race(['rate' => ['perMinute' => 30], 'loop' => ['mode' => 'off'], 'namespace' => 'rate-only'], 20, 10, $factory));
        } finally {
            $connect()->exec("DROP SCHEMA IF EXISTS {$schema} CASCADE");
        }
    }

    public function testTheRaceHoldsOnRedis(): void
    {
        $address = getenv('AGENT_GUARD_REDIS');
        if (!is_string($address) || $address === '') {
            self::markTestSkipped('Set AGENT_GUARD_REDIS=host:port to race on Redis.');
        }
        [$host, $port] = array_pad(explode(':', $address, 2), 2, '6379');
        $prefix = 'race-' . bin2hex(random_bytes(4)) . ':';
        $phpredis = static function () use ($host, $port, $prefix): Store {
            $client = new \Redis();
            $client->connect($host, (int) $port, 2.0);
            $client->setOption(\Redis::OPT_PREFIX, $prefix);
            return new RedisStore($client);
        };
        $predis = static fn (): Store => new RedisStore(new \Predis\Client(['host' => $host, 'port' => (int) $port], ['prefix' => $prefix . 'p:']));
        self::assertSame(50, $this->race(['budgets' => ['perDay' => 50], 'rate' => ['perMinute' => 120], 'loop' => ['mode' => 'off']], 20, 10, $phpredis));
        self::assertSame(30, $this->race(['rate' => ['perMinute' => 30], 'loop' => ['mode' => 'off'], 'namespace' => 'rate-only'], 20, 10, $predis));
    }

    public function testConcurrentChecksNeverOvershootTheRateCeiling(): void
    {
        $allowed = $this->race(['rate' => ['perMinute' => 30], 'loop' => ['mode' => 'off']], 20, 10);
        self::assertSame(30, $allowed);
    }

    public function testABudgetRefusalUnderRaceGivesBackItsRateSlot(): void
    {
        // Rate 100/min, budget 50: 50 allowed, and the 150 budget refusals hand their rate slots back.
        $allowed = $this->race(['rate' => ['perMinute' => 100], 'budgets' => ['perHour' => 50], 'loop' => ['mode' => 'off']], 20, 10);
        self::assertSame(50, $allowed);
        $guard = Guard::create(['store' => $this->sqliteStore(), 'clock' => static fn (): int => self::NOW, 'rate' => ['perMinute' => 100], 'loop' => ['mode' => 'off']]);
        $decision = $guard->check(self::SEND);
        self::assertSame(Outcome::ALLOW, $decision->outcome);
        self::assertSame(51, $decision->evidence['rate_used']);
    }

    public function testEveryBudgetRefusalNamesTheTokenAndWhenItResets(): void
    {
        $guard = Guard::create(['budgets' => ['perDay' => 1], 'clock' => static fn (): int => self::NOW, 'loop' => ['mode' => 'off']]);
        self::assertTrue($guard->check(self::SEND)->isAllowed());
        $blocked = $guard->check(self::SEND);
        self::assertSame(Reason::AGENT_BUDGET_EXCEEDED, $blocked->reason);
        self::assertSame(1, $blocked->evidence['budget']);
        self::assertSame('day', $blocked->evidence['period']);
        self::assertSame('Key "default" has used its daily budget of 1 email; it resets at 2027-01-16T00:00:00Z.', $blocked->message);
    }

    public function testThePerMinuteCeilingRefusesIndependentlyAndConsumesNoBudget(): void
    {
        $guard = Guard::create([
            'budgets' => ['perDay' => 1_000],
            'rate' => ['perMinute' => 5],
            'clock' => static fn (): int => self::NOW,
            'loop' => ['mode' => 'off'],
        ]);
        for ($i = 0; $i < 5; $i++) {
            self::assertTrue($guard->check(self::SEND)->isAllowed());
        }
        $sixth = $guard->check(self::SEND);
        self::assertSame(Reason::RATE_CEILING_EXCEEDED, $sixth->reason);
        self::assertSame(5, $sixth->evidence['sends_in_window']);
        self::assertSame(5, $sixth->evidence['ceiling_per_minute']);
        self::assertGreaterThan(0, $sixth->evidence['retry_after_seconds']);
        self::assertSame(5, $guard->store()->getCounter('agent-email-guard:default:budget:day:' . Guard::periodBounds('day', self::NOW)[0]));
    }

    public function testReleaseGivesBackExactlyOnce(): void
    {
        $store = $this->sqliteStore();
        $store->createSchema();
        $this->assertReleaseOnce($store);
        $this->assertReleaseOnce(new \AgentiSend\AgentEmailGuard\Store\MemoryStore());
    }

    private function assertReleaseOnce(Store $store): void
    {
        $guard = Guard::create(['store' => $store, 'budgets' => ['perHour' => 10], 'rate' => ['perMinute' => 10], 'clock' => static fn (): int => self::NOW, 'loop' => ['mode' => 'off']]);
        $first = $guard->check(self::SEND);
        $guard->check(self::SEND);
        $guard->release($first);
        $guard->release($first);
        $third = $guard->check(self::SEND);
        self::assertSame(2, $third->evidence['hour_used']);
        self::assertSame(2, $third->evidence['rate_used']);
    }
}
