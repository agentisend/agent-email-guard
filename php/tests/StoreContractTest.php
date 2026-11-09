<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\SendRecord;
use AgentiSend\AgentEmailGuard\Store\MemoryStore;
use AgentiSend\AgentEmailGuard\Store\PdoStore;
use AgentiSend\AgentEmailGuard\Store\RedisStore;
use AgentiSend\AgentEmailGuard\Store\Store;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * SPEC §6.1 against every backend. Redis and Postgres run when these are set:
 *   AGENT_GUARD_REDIS=127.0.0.1:6379
 *   AGENT_GUARD_PG_DSN="pgsql:host=127.0.0.1;port=5432;dbname=test"  AGENT_GUARD_PG_USER=...  AGENT_GUARD_PG_PASSWORD=...
 * Postgres tests work in a schema of their own and drop it afterwards.
 */
final class StoreContractTest extends TestCase
{
    private const NOW = 1_800_000_000_000;

    /** @var list<\Closure(): void> */
    private static array $cleanups = [];

    public static function tearDownAfterClass(): void
    {
        foreach (self::$cleanups as $cleanup) {
            $cleanup();
        }
        self::$cleanups = [];
    }

    /** @return iterable<string, array{string}> */
    public static function backends(): iterable
    {
        yield 'memory' => ['memory'];
        yield 'sqlite' => ['sqlite'];
        yield 'redis (phpredis)' => ['phpredis'];
        yield 'redis (predis)' => ['predis'];
        yield 'postgres' => ['pgsql'];
    }

    private static function store(string $backend): Store
    {
        $ns = 'contract-' . bin2hex(random_bytes(4));
        switch ($backend) {
            case 'memory':
                return new MemoryStore();
            case 'sqlite':
                $store = new PdoStore(new \PDO('sqlite::memory:'));
                $store->createSchema();
                return $store;
            case 'phpredis':
            case 'predis':
                [$host, $port] = self::redisAddress();
                if ($backend === 'phpredis') {
                    if (!class_exists(\Redis::class)) {
                        self::markTestSkipped('ext-redis is not loaded.');
                    }
                    $client = new \Redis();
                    $client->connect($host, $port, 2.0);
                    $client->setOption(\Redis::OPT_PREFIX, $ns . ':');
                    return new RedisStore($client);
                }
                return new RedisStore(new \Predis\Client(['host' => $host, 'port' => $port], ['prefix' => $ns . ':']));
            case 'pgsql':
                $pdo = self::postgres();
                $schema = 'agent_guard_test_' . bin2hex(random_bytes(4));
                $pdo->exec("CREATE SCHEMA {$schema}");
                $pdo->exec("SET search_path TO {$schema}");
                self::$cleanups[] = static function () use ($schema): void {
                    self::postgres()->exec("DROP SCHEMA IF EXISTS {$schema} CASCADE");
                };
                $store = new PdoStore($pdo);
                $store->createSchema();
                return $store;
        }
        throw new \LogicException($backend);
    }

    /** @return array{string, int} */
    private static function redisAddress(): array
    {
        $address = getenv('AGENT_GUARD_REDIS');
        if (!is_string($address) || $address === '') {
            self::markTestSkipped('Set AGENT_GUARD_REDIS=host:port to run the Redis store against a server.');
        }
        [$host, $port] = array_pad(explode(':', $address, 2), 2, '6379');
        return [$host, (int) $port];
    }

    private static function postgres(): \PDO
    {
        $dsn = getenv('AGENT_GUARD_PG_DSN');
        if (!is_string($dsn) || $dsn === '') {
            self::markTestSkipped('Set AGENT_GUARD_PG_DSN (plus AGENT_GUARD_PG_USER / AGENT_GUARD_PG_PASSWORD) to run the Postgres store.');
        }
        $user = getenv('AGENT_GUARD_PG_USER');
        $password = getenv('AGENT_GUARD_PG_PASSWORD');
        return new \PDO($dsn, is_string($user) ? $user : null, is_string($password) ? $password : null);
    }

    #[DataProvider('backends')]
    public function testIncrementWithCeilingIsConditional(string $backend): void
    {
        $s = self::store($backend);
        self::assertSame(0, $s->getCounter('c'));
        $r = $s->incrementWithCeiling('c', 1, 2, self::NOW + 60_000);
        self::assertTrue($r->ok);
        self::assertSame(1, $r->value);
        self::assertTrue($s->incrementWithCeiling('c', 1, 2, self::NOW + 60_000)->ok);
        $blocked = $s->incrementWithCeiling('c', 1, 2, self::NOW + 60_000);
        self::assertFalse($blocked->ok);
        self::assertSame(2, $blocked->value);
        self::assertSame(2, $s->getCounter('c'));
        self::assertFalse($s->incrementWithCeiling('fresh', 3, 2, null)->ok, 'an amount over the ceiling never creates a counter');
        self::assertSame(0, $s->getCounter('fresh'));
        $unbounded = $s->incrementWithCeiling('seen', 1, null, null);
        self::assertTrue($unbounded->ok);
        self::assertSame(2, $s->incrementWithCeiling('seen', 1, null, null)->value);
    }

    #[DataProvider('backends')]
    public function testDecrementNeverGoesBelowZero(string $backend): void
    {
        $s = self::store($backend);
        $s->decrement('missing', 1);
        self::assertSame(0, $s->getCounter('missing'));
        $s->incrementWithCeiling('c', 2, null, null);
        $s->decrement('c', 5);
        self::assertSame(0, $s->getCounter('c'));
    }

    #[DataProvider('backends')]
    public function testTheSlidingWindowDropsOldMembersAndReportsTheOldest(string $backend): void
    {
        $s = self::store($backend);
        $a = $s->windowAdd('w', 'a', self::NOW, 60_000, 2);
        self::assertTrue($a->ok);
        self::assertSame(1, $a->count);
        self::assertSame(self::NOW, $a->oldestAt);
        self::assertTrue($s->windowAdd('w', 'b', self::NOW + 10_000, 60_000, 2)->ok);
        $full = $s->windowAdd('w', 'c', self::NOW + 20_000, 60_000, 2);
        self::assertFalse($full->ok);
        self::assertSame(2, $full->count);
        self::assertSame(self::NOW, $full->oldestAt);
        // At exactly 60,000 ms the first member leaves the window.
        $later = $s->windowAdd('w', 'd', self::NOW + 60_000, 60_000, 2);
        self::assertTrue($later->ok);
        self::assertSame(2, $later->count);
        self::assertSame(self::NOW + 10_000, $later->oldestAt);
        $s->windowRemove('w', 'd');
        self::assertTrue($s->windowAdd('w', 'e', self::NOW + 60_001, 60_000, 2)->ok);
    }

    #[DataProvider('backends')]
    public function testTheSendLogKeepsOrderAndDropsWhatIsOutOfReach(string $backend): void
    {
        $s = self::store($backend);
        for ($i = 0; $i < 5; $i++) {
            $s->appendSend('log', SendRecord::fromSend(['to' => "r{$i}@x.com, a@x.com", 'subject' => "S {$i}", 'text' => 'Body'], self::NOW + $i * 1_000), 3_000);
        }
        $all = $s->recentSends('log', 0);
        self::assertSame([self::NOW + 1_000, self::NOW + 2_000, self::NOW + 3_000, self::NOW + 4_000], array_map(static fn (SendRecord $r): int => $r->at, $all));
        self::assertSame('a@x.com,r4@x.com', $all[3]->toLine);
        self::assertSame(['r4@x.com', 'a@x.com'], $all[3]->recipients);
        self::assertSame('s 4', $all[3]->subject);
        self::assertCount(2, $s->recentSends('log', self::NOW + 3_000));
        self::assertSame([], $s->recentSends('other', 0));
    }

    #[DataProvider('backends')]
    public function testStateSetsOverwritesAndDeletes(string $backend): void
    {
        $s = self::store($backend);
        self::assertNull($s->getState('k'));
        $s->setState('k', '{"a":1}');
        $s->setState('k', '{"a":2}');
        self::assertSame('{"a":2}', $s->getState('k'));
        $s->setState('k', null);
        self::assertNull($s->getState('k'));
    }

    #[DataProvider('backends')]
    public function testAGuardRunsEndToEndOnTheStore(string $backend): void
    {
        $now = self::NOW;
        $guard = Guard::create(['store' => self::store($backend), 'clock' => static function () use (&$now): int {
            return $now;
        }, 'budgets' => ['perHour' => 3], 'rate' => ['perMinute' => 2], 'approval' => ['newRecipients' => true]]);
        $send = ['to' => 'a@example.com', 'subject' => 'Same', 'text' => 'Same body'];
        self::assertTrue($guard->check($send)->isHeld());
        $approved = $guard->check($send, ['approved' => true]);
        self::assertTrue($approved->isAllowed());
        $guard->record($send);
        self::assertTrue($guard->check($send)->isAllowed());
        $guard->record($send);
        self::assertSame('rate_ceiling_exceeded', $guard->check($send)->reason);
        $now += 60_000;
        self::assertTrue($guard->check($send)->isAllowed());
        $guard->record($send);
        $now += 60_000;
        // Three near-identical sends are in the window now.
        self::assertSame('loop_repetition_detected', $guard->check($send)->reason);
        $guard->killSwitch()->pause('stop', 'ops');
        self::assertSame('kill_switch_active', $guard->check($send)->reason);
        self::assertTrue($guard->killSwitch()->resume('ops'));
        self::assertSame('agent_budget_exceeded', $guard->check(['to' => 'a@example.com', 'subject' => 'Other', 'text' => 'Different'])->reason);
    }
}
