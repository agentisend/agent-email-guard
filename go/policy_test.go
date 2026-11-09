package emailguard

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const specExamplePolicy = `{
  "version": 1,
  "key": "support-agent",
  "budgets": { "per_hour": 50, "per_day": 300, "per_month": 5000 },
  "rate": { "per_minute": 10 },
  "loop": { "mode": "full", "window_ms": 3600000, "similarity_threshold": 0.85, "max_identical_sends": 3, "min_window_for_entropy": 20, "recipient_perplexity_floor": 3 },
  "approval": { "new_recipients": false, "recipients": ["@bigcustomer.com"] },
  "suppress": ["@competitor.example"]
}`

func TestPolicy_ParsesTheSpecExample(t *testing.T) {
	path := filepath.Join(t.TempDir(), PolicyFile)
	if err := os.WriteFile(path, []byte(specExamplePolicy), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadPolicy(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Key != "support-agent" || *c.Budgets.PerHour != 50 || *c.Budgets.PerDay != 300 || *c.Budgets.PerMonth != 5000 ||
		*c.Rate.PerMinute != 10 || c.Loop.Mode != LoopFull || c.Loop.Window != time.Hour || c.Loop.SimilarityThreshold != 0.85 ||
		c.Approval.Recipients[0] != "@bigcustomer.com" || c.Suppress[0] != "@competitor.example" {
		t.Fatalf("config = %+v", c)
	}
}

func TestPolicy_EmptyObjectIsValidAndZeroBudgetIsKept(t *testing.T) {
	c, err := ParsePolicy([]byte(`{"$schema": "x", "budgets": {"per_day": 0}}`))
	if err != nil || c.Budgets.PerDay == nil || *c.Budgets.PerDay != 0 || c.Budgets.PerHour != nil {
		t.Fatalf("config = %+v err = %v", c, err)
	}
}

func TestPolicy_RejectsTheWholeFileNamingEveryProblem(t *testing.T) {
	_, err := ParsePolicy([]byte(`{"budgets": {"perDay": 5, "per_hour": -1}, "loop": {"mode": "fast"}, "suppress": "x", "extra": 1, "rate": 3}`))
	want := `Invalid agent-email-guard policy: Unknown key "budgets.perDay". "budgets.per_hour" has the wrong type. "loop.mode" has the wrong type. "suppress" has the wrong type. Unknown key "extra". "rate" must be an object.`
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v", err)
	}
	for _, bad := range []string{`[]`, `{`, `{"version": 2}`, `{"key": ""}`, `{"loop": {"similarity_threshold": 0}}`} {
		if _, err := ParsePolicy([]byte(bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
