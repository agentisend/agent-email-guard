<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

use AgentiSend\AgentEmailGuard\SendRecord;

/**
 * A store in Postgres or SQLite through PDO (the MySQL/MariaDB path is
 * written but not yet covered by the test run). Every PHP worker
 * pointed at the same database shares one set of budgets, rate windows,
 * send logs and one kill switch.
 *
 * Atomicity (SPEC §6.2): incrementWithCeiling() is one conditional
 * UPDATE/upsert; windowAdd() runs inside a transaction holding a lock on the
 * window's name (pg_advisory_xact_lock, GET_LOCK, or SQLite's write lock).
 *
 * Create the tables once with createSchema(), or run schemaSql() through
 * your own migrations.
 */
final class PdoStore implements Store
{
    private readonly string $driver;
    private readonly string $counters;
    private readonly string $windows;
    private readonly string $sends;
    private readonly string $state;

    /** @param string $tablePrefix tables are {prefix}_counters, _windows, _sends and _state (SPEC §6.4) */
    public function __construct(private readonly \PDO $pdo, string $tablePrefix = 'agent_email_guard')
    {
        if (preg_match('/^[a-z_][a-z0-9_]{0,40}$/', $tablePrefix) !== 1) {
            throw new \InvalidArgumentException('tablePrefix must be lowercase letters, digits and underscores, starting with a letter or underscore.');
        }
        $driver = $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME);
        if (!is_string($driver) || !in_array($driver, ['pgsql', 'mysql', 'sqlite'], true)) {
            throw new \InvalidArgumentException('PdoStore supports the pgsql, mysql and sqlite PDO drivers.');
        }
        $this->driver = $driver;
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->counters = $tablePrefix . '_counters';
        $this->windows = $tablePrefix . '_windows';
        $this->sends = $tablePrefix . '_sends';
        $this->state = $tablePrefix . '_state';
    }

    /** @return list<string> CREATE TABLE / INDEX statements for this driver. */
    public function schemaSql(): array
    {
        $id = match ($this->driver) {
            'pgsql' => 'BIGSERIAL PRIMARY KEY',
            'mysql' => 'BIGINT AUTO_INCREMENT PRIMARY KEY',
            default => 'INTEGER PRIMARY KEY AUTOINCREMENT',
        };
        // Postgres is the SPEC §6.4 layout byte for byte, so Node, Python and Go workers share it.
        $key = $this->driver === 'mysql' ? 'VARCHAR(512)' : 'TEXT';
        $member = $this->driver === 'mysql' ? 'VARCHAR(128)' : 'TEXT';
        $text = $this->driver === 'mysql' ? 'MEDIUMTEXT' : 'TEXT';
        $json = match ($this->driver) {
            'pgsql' => 'JSONB',
            'mysql' => 'JSON',
            default => 'TEXT',
        };
        $index = $this->driver === 'mysql' ? '' : ' IF NOT EXISTS';
        $statements = [
            "CREATE TABLE IF NOT EXISTS {$this->counters} (name {$key} PRIMARY KEY, value BIGINT NOT NULL, expires_at BIGINT NULL)",
            "CREATE TABLE IF NOT EXISTS {$this->windows} (name {$key} NOT NULL, member {$member} NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (name, member))",
            "CREATE TABLE IF NOT EXISTS {$this->sends} (id {$id}, log {$key} NOT NULL, at BIGINT NOT NULL, record {$json} NOT NULL)",
            "CREATE TABLE IF NOT EXISTS {$this->state} (name {$key} PRIMARY KEY, value {$text} NOT NULL)",
        ];
        if ($this->driver === 'mysql') {
            $statements[] = "CREATE INDEX {$this->sends}_log_at ON {$this->sends} (log, at)";
        } else {
            $statements[] = "CREATE INDEX{$index} {$this->sends}_log_at ON {$this->sends} (log, at)";
        }
        return $statements;
    }

    /** Create the four tables (idempotent on Postgres and SQLite; on MySQL an existing index is left alone). */
    public function createSchema(): void
    {
        foreach ($this->schemaSql() as $sql) {
            try {
                $this->pdo->exec($sql);
            } catch (\PDOException $e) {
                // MySQL has no CREATE INDEX IF NOT EXISTS: 1061 = duplicate key name.
                if ($this->driver !== 'mysql' || !str_contains($e->getMessage(), '1061')) {
                    throw $e;
                }
            }
        }
    }

    /** Delete counters whose period ended and send-log rows older than $olderThanMs. Run it from a scheduler. */
    public function purgeExpired(int $nowMs, int $olderThanMs = 86_400_000): void
    {
        $this->run("DELETE FROM {$this->counters} WHERE expires_at IS NOT NULL AND expires_at <= ?", [$nowMs]);
        $this->run("DELETE FROM {$this->sends} WHERE at < ?", [$nowMs - $olderThanMs]);
    }

    public function incrementWithCeiling(string $name, int $amount, ?int $ceiling, ?int $expiresAt): CounterResult
    {
        if ($ceiling !== null && $amount > $ceiling) {
            return new CounterResult(false, $this->getCounter($name));
        }
        if ($this->driver === 'mysql') {
            return $this->incrementMysql($name, $amount, $ceiling, $expiresAt);
        }
        $c = $this->counters;
        $sql = "INSERT INTO {$c} (name, value, expires_at) VALUES (?, ?, ?) "
            . "ON CONFLICT (name) DO UPDATE SET value = {$c}.value + excluded.value, expires_at = COALESCE(excluded.expires_at, {$c}.expires_at)";
        $params = [$name, $amount, $expiresAt];
        if ($ceiling !== null) {
            $sql .= " WHERE {$c}.value + excluded.value <= ?";
            $params[] = $ceiling;
        }
        $sql .= ' RETURNING value';
        $value = $this->run($sql, $params)->fetchColumn();
        if ($value === false) {
            return new CounterResult(false, $this->getCounter($name));
        }
        return new CounterResult(true, self::toInt($value));
    }

    private function incrementMysql(string $name, int $amount, ?int $ceiling, ?int $expiresAt): CounterResult
    {
        $c = $this->counters;
        // LAST_INSERT_ID(expr) hands this connection the value its own UPDATE wrote.
        $update = "UPDATE {$c} SET value = LAST_INSERT_ID(value + ?), expires_at = COALESCE(?, expires_at) WHERE name = ?";
        $params = [$amount, $expiresAt, $name];
        if ($ceiling !== null) {
            $update .= ' AND value + ? <= ?';
            $params[] = $amount;
            $params[] = $ceiling;
        }
        for ($attempt = 0; $attempt < 2; $attempt++) {
            if ($this->run($update, $params)->rowCount() === 1) {
                return new CounterResult(true, self::toInt($this->run('SELECT LAST_INSERT_ID()')->fetchColumn()));
            }
            if ($attempt === 0) {
                $insert = $this->run("INSERT IGNORE INTO {$c} (name, value, expires_at) VALUES (?, ?, ?)", [$name, $amount, $expiresAt]);
                if ($insert->rowCount() === 1) {
                    return new CounterResult(true, $amount);
                }
                // The row exists (or another worker just created it): the conditional UPDATE decides.
            }
        }
        return new CounterResult(false, $this->getCounter($name));
    }

    public function decrement(string $name, int $amount): void
    {
        $this->run(
            "UPDATE {$this->counters} SET value = CASE WHEN value > ? THEN value - ? ELSE 0 END WHERE name = ?",
            [$amount, $amount, $name],
        );
    }

    public function getCounter(string $name): int
    {
        $value = $this->run("SELECT value FROM {$this->counters} WHERE name = ?", [$name])->fetchColumn();
        return $value === false ? 0 : self::toInt($value);
    }

    public function windowAdd(string $name, string $member, int $at, int $windowMs, int $ceiling): WindowResult
    {
        return $this->locked($name, function () use ($name, $member, $at, $windowMs, $ceiling): WindowResult {
            $w = $this->windows;
            $this->run("DELETE FROM {$w} WHERE name = ? AND at <= ?", [$name, $at - $windowMs]);
            $row = $this->run("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM {$w} WHERE name = ?", [$name])->fetch(\PDO::FETCH_ASSOC);
            $count = is_array($row) ? self::toInt($row['n'] ?? 0) : 0;
            $oldest = is_array($row) && ($row['oldest'] ?? null) !== null ? self::toInt($row['oldest']) : null;
            if ($count >= $ceiling) {
                return new WindowResult(false, $count, $oldest);
            }
            $this->run("INSERT INTO {$w} (name, member, at) VALUES (?, ?, ?)", [$name, $member, $at]);
            return new WindowResult(true, $count + 1, $oldest ?? $at);
        });
    }

    public function windowRemove(string $name, string $member): void
    {
        $this->run("DELETE FROM {$this->windows} WHERE name = ? AND member = ?", [$name, $member]);
    }

    public function appendSend(string $log, SendRecord $record, int $keepMs): void
    {
        $cast = $this->driver === 'pgsql' ? '?::jsonb' : '?';
        $this->run("INSERT INTO {$this->sends} (log, at, record) VALUES (?, ?, {$cast})", [$log, $record->at, $record->toJson()]);
        $this->run("DELETE FROM {$this->sends} WHERE log = ? AND at < ?", [$log, $record->at - $keepMs]);
    }

    public function recentSends(string $log, int $since): array
    {
        $column = $this->driver === 'pgsql' ? 'record::text' : 'record';
        $statement = $this->run("SELECT {$column} FROM {$this->sends} WHERE log = ? AND at >= ? ORDER BY at, id", [$log, $since]);
        $out = [];
        while (($json = $statement->fetchColumn()) !== false) {
            if (is_string($json)) {
                $out[] = SendRecord::fromJson($json);
            }
        }
        return $out;
    }

    public function getState(string $name): ?string
    {
        $value = $this->run("SELECT value FROM {$this->state} WHERE name = ?", [$name])->fetchColumn();
        return is_string($value) ? $value : null;
    }

    public function setState(string $name, ?string $value): void
    {
        if ($value === null) {
            $this->run("DELETE FROM {$this->state} WHERE name = ?", [$name]);
            return;
        }
        $sql = $this->driver === 'mysql'
            ? "INSERT INTO {$this->state} (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)"
            : "INSERT INTO {$this->state} (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value";
        $this->run($sql, [$name, $value]);
    }

    /**
     * Run $fn holding an exclusive lock on $name, inside a transaction.
     *
     * @template T
     * @param \Closure(): T $fn
     * @return T
     */
    private function locked(string $name, \Closure $fn): mixed
    {
        $began = false;
        if (!$this->pdo->inTransaction()) {
            if ($this->driver === 'sqlite') {
                // BEGIN IMMEDIATE takes SQLite's write lock now, not at the first write.
                $this->retryBusy(fn () => $this->pdo->exec('BEGIN IMMEDIATE'));
            } else {
                $this->pdo->beginTransaction();
            }
            $began = true;
        }
        $mysqlLock = null;
        try {
            if ($this->driver === 'pgsql') {
                $this->run('SELECT pg_advisory_xact_lock(hashtext(?))', [$name]);
            } elseif ($this->driver === 'mysql') {
                $mysqlLock = 'agent-email-guard:' . substr(sha1($name), 0, 40);
                $got = $this->run('SELECT GET_LOCK(?, 10)', [$mysqlLock])->fetchColumn();
                if (self::toInt($got) !== 1) {
                    throw new \RuntimeException('agent-email-guard could not lock the rate window within 10 seconds.');
                }
            }
            $result = $fn();
            if ($began) {
                $this->finish(true);
            }
            return $result;
        } catch (\Throwable $e) {
            if ($began) {
                $this->finish(false);
            }
            throw $e;
        } finally {
            if ($mysqlLock !== null) {
                $this->run('SELECT RELEASE_LOCK(?)', [$mysqlLock]);
            }
        }
    }

    private function finish(bool $commit): void
    {
        if ($this->driver === 'sqlite') {
            // PDO does not track a transaction opened with exec('BEGIN IMMEDIATE').
            $this->pdo->exec($commit ? 'COMMIT' : 'ROLLBACK');
        } elseif ($commit) {
            $this->pdo->commit();
        } else {
            $this->pdo->rollBack();
        }
    }

    /** SQLite's BEGIN IMMEDIATE waits for the busy timeout; keep trying past it a few times. */
    private function retryBusy(\Closure $fn): void
    {
        for ($i = 0; ; $i++) {
            try {
                $fn();
                return;
            } catch (\PDOException $e) {
                if ($i >= 50 || !str_contains($e->getMessage(), 'locked')) {
                    throw $e;
                }
                usleep(2000 * ($i + 1));
            }
        }
    }

    /** @param list<string|int|null> $params */
    private function run(string $sql, array $params = []): \PDOStatement
    {
        $statement = $this->pdo->prepare($sql);
        foreach ($params as $i => $value) {
            $type = is_int($value) ? \PDO::PARAM_INT : ($value === null ? \PDO::PARAM_NULL : \PDO::PARAM_STR);
            $statement->bindValue($i + 1, $value, $type);
        }
        $statement->execute();
        return $statement;
    }

    private static function toInt(mixed $value): int
    {
        return is_int($value) ? $value : (is_numeric($value) ? (int) $value : 0);
    }
}
