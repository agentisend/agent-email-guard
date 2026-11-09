// Package pgstore is an emailguard.Store on PostgreSQL through database/sql, so it
// works with whichever driver you already use (pgx's stdlib, lib/pq) and
// adds no dependency of its own. Every process on one database shares
// budgets, rate windows, loop history and the kill switch.
//
//	db, _ := sql.Open("pgx", os.Getenv("DATABASE_URL"))
//	store := pgstore.New(db, pgstore.Options{})
//	if err := store.Migrate(ctx); err != nil { ... }
//	g := emailguard.New(emailguard.Config{Store: store, ...})
package pgstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	emailguard "github.com/agentisend/agent-email-guard/go"
)

// Options configures where the tables live.
type Options struct {
	// Schema holds the tables. Empty means the connection's search_path.
	Schema string
	// TablePrefix starts every table name: <prefix>_counters, _windows, _sends,
	// _state. Default "agent_email_guard", the layout every port shares.
	TablePrefix string
}

// Store implements emailguard.Store on PostgreSQL.
type Store struct {
	db                                     *sql.DB
	counters, window, log, state, logIndex string
}

var ident = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// New returns a Store. It panics on a schema or prefix that is not a plain
// SQL identifier, since those are spliced into statements.
func New(db *sql.DB, opts Options) *Store {
	if opts.TablePrefix == "" {
		opts.TablePrefix = "agent_email_guard"
	}
	if !ident.MatchString(opts.TablePrefix) || (opts.Schema != "" && !ident.MatchString(opts.Schema)) {
		panic(fmt.Sprintf("pgstore: schema %q and prefix %q must be plain identifiers", opts.Schema, opts.TablePrefix))
	}
	q := func(name string) string {
		if opts.Schema != "" {
			return `"` + opts.Schema + `"."` + opts.TablePrefix + "_" + name + `"`
		}
		return `"` + opts.TablePrefix + "_" + name + `"`
	}
	return &Store{db: db, counters: q("counters"), window: q("windows"), log: q("sends"), state: q("state"), logIndex: `"` + opts.TablePrefix + `_sends_log_at"`}
}

var _ emailguard.Store = (*Store)(nil)

// Migrate creates the tables if they do not exist. Safe to run on every boot.
func (s *Store) Migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS ` + s.counters + ` (name text PRIMARY KEY, value bigint NOT NULL, expires_at bigint)`,
		`CREATE TABLE IF NOT EXISTS ` + s.window + ` (name text NOT NULL, member text NOT NULL, at bigint NOT NULL, PRIMARY KEY (name, member))`,
		`CREATE TABLE IF NOT EXISTS ` + s.log + ` (id bigserial PRIMARY KEY, log text NOT NULL, at bigint NOT NULL, record jsonb NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS ` + s.logIndex + ` ON ` + s.log + ` (log, at)`,
		`CREATE TABLE IF NOT EXISTS ` + s.state + ` (name text PRIMARY KEY, value text NOT NULL)`,
	}
	for _, q := range stmts {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("pgstore: migrate: %w", err)
		}
	}
	return nil
}

// IncrementWithCeiling implements emailguard.Store in one statement: the upsert's
// conditional update holds the row lock, so concurrent callers serialize.
func (s *Store) IncrementWithCeiling(ctx context.Context, name string, amount int64, ceiling *int64, expiresAt int64) (int64, bool, error) {
	q := `WITH ins AS (
  INSERT INTO ` + s.counters + ` AS c (name, value, expires_at)
  SELECT $1, $2::bigint, NULLIF($4::bigint, 0)
  WHERE $3::bigint IS NULL OR $2::bigint <= $3::bigint
  ON CONFLICT (name) DO UPDATE SET value = c.value + EXCLUDED.value
  WHERE $3::bigint IS NULL OR c.value + EXCLUDED.value <= $3::bigint
  RETURNING value
)
SELECT value, true FROM ins
UNION ALL
SELECT COALESCE((SELECT value FROM ` + s.counters + ` WHERE name = $1), 0), false
WHERE NOT EXISTS (SELECT 1 FROM ins)`
	var v int64
	var ok bool
	err := s.db.QueryRowContext(ctx, q, name, amount, ceiling, expiresAt).Scan(&v, &ok)
	return v, ok, err
}

// Decrement implements emailguard.Store.
func (s *Store) Decrement(ctx context.Context, name string, amount int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE `+s.counters+` SET value = GREATEST(value - $2, 0) WHERE name = $1`, name, amount)
	return err
}

// GetCounter implements emailguard.Store.
func (s *Store) GetCounter(ctx context.Context, name string) (int64, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT value FROM `+s.counters+` WHERE name = $1`, name).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return v, err
}

// WindowAdd implements emailguard.Store. A transaction-scoped advisory lock on the
// window name serializes callers of the same window.
func (s *Store) WindowAdd(ctx context.Context, name, member string, at, windowMs, ceiling int64) (res emailguard.WindowResult, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, s.window+name); err != nil {
		return res, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM `+s.window+` WHERE name = $1 AND at <= $2`, name, at-windowMs); err != nil {
		return res, err
	}
	var oldest sql.NullInt64
	if err = tx.QueryRowContext(ctx, `SELECT count(*), min(at) FROM `+s.window+` WHERE name = $1`, name).Scan(&res.Count, &oldest); err != nil {
		return res, err
	}
	res.OldestAt, res.HasOldest = oldest.Int64, oldest.Valid
	if res.Count < ceiling {
		if _, err = tx.ExecContext(ctx, `INSERT INTO `+s.window+` (name, member, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, name, member, at); err != nil {
			return res, err
		}
		res.OK = true
		res.Count++
		if !res.HasOldest {
			res.OldestAt, res.HasOldest = at, true
		}
	}
	err = tx.Commit()
	return res, err
}

// WindowRemove implements emailguard.Store.
func (s *Store) WindowRemove(ctx context.Context, name, member string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM `+s.window+` WHERE name = $1 AND member = $2`, name, member)
	return err
}

// AppendSend implements emailguard.Store.
func (s *Store) AppendSend(ctx context.Context, log string, record emailguard.SendRecord, keepMs int64) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO `+s.log+` (log, at, record) VALUES ($1, $2, $3)`, log, record.At, string(raw)); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM `+s.log+` WHERE log = $1 AND at < $2`, log, record.At-keepMs); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM `+s.log+` WHERE log = $1 AND id <= (
  SELECT id FROM `+s.log+` WHERE log = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`, log, emailguard.SendLogCap)
	return err
}

// RecentSends implements emailguard.Store.
func (s *Store) RecentSends(ctx context.Context, log string, since int64) ([]emailguard.SendRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT record FROM `+s.log+` WHERE log = $1 AND at >= $2 ORDER BY id`, log, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []emailguard.SendRecord
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var r emailguard.SendRecord
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetState implements emailguard.Store.
func (s *Store) GetState(ctx context.Context, name string) (string, bool, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM `+s.state+` WHERE name = $1`, name).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetState implements emailguard.Store.
func (s *Store) SetState(ctx context.Context, name string, value *string) error {
	if value == nil {
		_, err := s.db.ExecContext(ctx, `DELETE FROM `+s.state+` WHERE name = $1`, name)
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO `+s.state+` (name, value) VALUES ($1, $2)
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`, name, *value)
	return err
}

// Prune deletes budget counters whose period ended before nowMs. Counter
// names carry their period, so stale rows are never read; this only reclaims
// space. Run it from a daily job if you like.
func (s *Store) Prune(ctx context.Context, nowMs int64) (int64, error) {
	r, err := s.db.ExecContext(ctx, `DELETE FROM `+s.counters+` WHERE expires_at IS NOT NULL AND expires_at <= $1`, nowMs)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}
