package pgstore_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"testing"

	emailguard "github.com/agentisend/agent-email-guard/go"
	"github.com/agentisend/agent-email-guard/go/pgstore"
	"github.com/agentisend/agent-email-guard/go/storetest"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// TestContract runs the store contract against AGENT_GUARD_PG_URL. Each
// subtest gets its own throwaway schema, dropped afterwards; nothing else in
// the database is touched.
func TestContract(t *testing.T) {
	url := os.Getenv("AGENT_GUARD_PG_URL")
	if url == "" {
		t.Skip("AGENT_GUARD_PG_URL not set")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	storetest.Run(t, func(t *testing.T) emailguard.Store {
		var b [6]byte
		_, _ = rand.Read(b[:])
		schema := "agent_email_guard_test_" + hex.EncodeToString(b[:])
		if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = db.ExecContext(ctx, `DROP SCHEMA `+schema+` CASCADE`) })
		s := pgstore.New(db, pgstore.Options{Schema: schema})
		if err := s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		if err := s.Migrate(ctx); err != nil {
			t.Fatalf("second migrate: %v", err)
		}
		return s
	})
}

func TestNewRejectsUnsafeIdentifiers(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic")
		}
	}()
	pgstore.New(nil, pgstore.Options{Schema: `x"; DROP TABLE y; --`})
}
