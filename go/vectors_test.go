package emailguard

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// The shared conformance vectors live in ../spec/vectors (the same layout in
// this repo and the public one). AGENT_GUARD_VECTORS overrides the directory.

type vecAddr []string

func (a *vecAddr) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*a = []string{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

type vecSend struct {
	Key     string  `json:"key"`
	To      vecAddr `json:"to"`
	Cc      vecAddr `json:"cc"`
	Bcc     vecAddr `json:"bcc"`
	Subject string  `json:"subject"`
	Text    string  `json:"text"`
	HTML    string  `json:"html"`
}

func (v vecSend) send() Send {
	return Send{Key: v.Key, To: v.To, Cc: v.Cc, Bcc: v.Bcc, Subject: v.Subject, Text: v.Text, HTML: v.HTML}
}

type vecConfig struct {
	Key       string `json:"key"`
	Namespace string `json:"namespace"`
	Budgets   *struct {
		PerHour  *int `json:"per_hour"`
		PerDay   *int `json:"per_day"`
		PerMonth *int `json:"per_month"`
	} `json:"budgets"`
	Rate *struct {
		PerMinute *int `json:"per_minute"`
	} `json:"rate"`
	Loop *struct {
		Mode                     LoopMode `json:"mode"`
		WindowMs                 int64    `json:"window_ms"`
		SimilarityThreshold      float64  `json:"similarity_threshold"`
		MaxIdenticalSends        int      `json:"max_identical_sends"`
		MinWindowForEntropy      int      `json:"min_window_for_entropy"`
		RecipientPerplexityFloor float64  `json:"recipient_perplexity_floor"`
	} `json:"loop"`
	Approval *struct {
		NewRecipients bool     `json:"new_recipients"`
		Recipients    []string `json:"recipients"`
		RequireFor    *struct {
			SubjectContains string  `json:"subject_contains"`
			Detail          *string `json:"detail"`
		} `json:"require_for"`
	} `json:"approval"`
	Suppress []string `json:"suppress"`
}

func (v vecConfig) config(clock func() time.Time) Config {
	c := Config{Key: v.Key, Namespace: v.Namespace, Suppress: v.Suppress, Clock: clock}
	if b := v.Budgets; b != nil {
		c.Budgets = Budgets{PerHour: b.PerHour, PerDay: b.PerDay, PerMonth: b.PerMonth}
	}
	if r := v.Rate; r != nil {
		c.Rate = Rate{PerMinute: r.PerMinute}
	}
	if l := v.Loop; l != nil {
		c.Loop = Loop{Mode: l.Mode, Window: time.Duration(l.WindowMs) * time.Millisecond, SimilarityThreshold: l.SimilarityThreshold,
			MaxIdenticalSends: l.MaxIdenticalSends, MinWindowForEntropy: l.MinWindowForEntropy, RecipientPerplexityFloor: l.RecipientPerplexityFloor}
	}
	if a := v.Approval; a != nil {
		c.Approval = Approval{NewRecipients: a.NewRecipients, Recipients: a.Recipients}
		if rf := a.RequireFor; rf != nil {
			c.Approval.RequireFor = func(_ context.Context, s Send) (bool, string) {
				if !strings.Contains(s.Subject, rf.SubjectContains) {
					return false, ""
				}
				if rf.Detail != nil {
					return true, *rf.Detail
				}
				return true, ""
			}
		}
	}
	return c
}

type vecStep struct {
	Op       string          `json:"op"`
	At       int64           `json:"at"`
	Send     vecSend         `json:"send"`
	Approved bool            `json:"approved"`
	Repeat   int             `json:"repeat"`
	EveryMs  int64           `json:"every_ms"`
	Step     int             `json:"step"`
	Reason   string          `json:"reason"`
	By       string          `json:"by"`
	Expect   json.RawMessage `json:"expect"`
	Note     string          `json:"note"`
	Name     string          `json:"name"`
}

type vecCase struct {
	Name   string    `json:"name"`
	Config vecConfig `json:"config"`
	Steps  []vecStep `json:"steps"`
}

type vecFile struct {
	Name  string    `json:"name"`
	Cases []vecCase `json:"cases"`
}

func vectorDir() string {
	if d := os.Getenv("AGENT_GUARD_VECTORS"); d != "" {
		return d
	}
	return filepath.Join("..", "spec", "vectors")
}

// asJSON normalizes a value through JSON so int, int64 and float64 compare
// by value, the way every other port sees them.
func asJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSpecVectors(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(vectorDir(), "*.json"))
	sort.Strings(files)
	if len(files) == 0 {
		t.Skipf("no vectors in %s yet", vectorDir())
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var vf vecFile
		if err := json.Unmarshal(raw, &vf); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if len(vf.Cases) == 0 {
			continue // e.g. a JSON schema file
		}
		for _, c := range vf.Cases {
			c := c
			t.Run(vf.Name+"/"+c.Name, func(t *testing.T) { runVectorCase(t, c) })
		}
	}
}

func runVectorCase(t *testing.T, c vecCase) {
	ctx := context.Background()
	clk := &msClock{}
	g := New(c.Config.config(clk.now))
	decisions := map[int]Decision{}
	for i, s := range c.Steps {
		clk.ms = s.At
		var actual any
		switch s.Op {
		case "check", "send":
			send := s.Send.send()
			cctx := ctx
			if s.Approved {
				cctx = Approved(ctx)
			}
			d, err := g.Check(cctx, send)
			if err != nil {
				t.Fatalf("step %d: %v", i, err)
			}
			if !d.IsValid() {
				t.Errorf("step %d: decision breaks the contract: %+v", i, d)
			}
			decisions[i] = d
			if s.Op == "send" && d.Allowed() {
				if err := g.Record(ctx, send); err != nil {
					t.Fatal(err)
				}
			}
			actual = d
		case "record":
			n := s.Repeat
			if n == 0 {
				n = 1
			}
			for k := 0; k < n; k++ {
				clk.ms = s.At + int64(k)*s.EveryMs
				if err := g.Record(ctx, s.Send.send()); err != nil {
					t.Fatal(err)
				}
			}
		case "release":
			d, ok := decisions[s.Step]
			if !ok {
				t.Fatalf("step %d releases step %d, which has no decision", i, s.Step)
			}
			if err := g.Release(ctx, d); err != nil {
				t.Fatal(err)
			}
		case "pause":
			if _, err := g.KillSwitch().Pause(ctx, s.Reason, s.By); err != nil {
				t.Fatal(err)
			}
		case "resume":
			ok, err := g.KillSwitch().Resume(ctx, s.By)
			if err != nil {
				t.Fatal(err)
			}
			actual = map[string]bool{"resumed": ok}
		case "read_state":
			raw, ok, err := g.Store().GetState(ctx, s.Name)
			if err != nil {
				t.Fatal(err)
			}
			var state any
			if ok {
				if err := json.Unmarshal([]byte(raw), &state); err != nil {
					t.Fatalf("step %d: state %s is not JSON: %v", i, s.Name, err)
				}
			}
			actual = map[string]any{"state": state}
		default:
			t.Fatalf("step %d: unknown op %q", i, s.Op)
		}
		if len(s.Expect) == 0 || actual == nil {
			continue
		}
		var want any
		if err := json.Unmarshal(s.Expect, &want); err != nil {
			t.Fatal(err)
		}
		got := asJSON(t, actual)
		if !reflect.DeepEqual(got, want) {
			gj, _ := json.MarshalIndent(got, "", "  ")
			wj, _ := json.MarshalIndent(want, "", "  ")
			t.Errorf("step %d (%s %s):\n got: %s\nwant: %s", i, s.Op, s.Note, gj, wj)
		}
	}
}

// TestPolicyValidationVectors runs spec/vectors/policy/validation.json: each
// case's policy must yield exactly the expected problems, in order.
func TestPolicyValidationVectors(t *testing.T) {
	path := filepath.Join(vectorDir(), "policy", "validation.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skipf("no %s yet", path)
	}
	if err != nil {
		t.Fatal(err)
	}
	var vf struct {
		Cases []struct {
			Name   string          `json:"name"`
			Policy json.RawMessage `json:"policy"`
			Expect struct {
				Problems []string `json:"problems"`
			} `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatal(err)
	}
	if len(vf.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range vf.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			got := ValidatePolicy(c.Policy)
			if len(got) == 0 && len(c.Expect.Problems) == 0 {
				if _, err := ParsePolicy(c.Policy); err != nil {
					t.Fatalf("valid policy did not parse: %v", err)
				}
				return
			}
			if !reflect.DeepEqual(got, c.Expect.Problems) {
				t.Fatalf("got  %q\nwant %q", got, c.Expect.Problems)
			}
			if _, err := ParsePolicy(c.Policy); err == nil {
				t.Fatal("invalid policy parsed")
			}
		})
	}
}
