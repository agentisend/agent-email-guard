package emailguard

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Send is the provider-neutral description of one email.
type Send struct {
	// Key names the agent (or API key, or tenant) budgets and loop state
	// count against. Empty means Config.Key, then "default".
	Key  string
	From string
	// To, Cc and Bcc take bare addresses or "Name <addr>"; one entry may
	// hold several, comma-separated.
	To      []string
	Cc      []string
	Bcc     []string
	Subject string
	// Text is the plain body. Loop detection compares Text, or HTML when
	// Text is empty.
	Text string
	HTML string
	// Approved marks a send a person has approved: the approval rules are
	// skipped, every other check still runs. Approved(ctx) does the same.
	Approved bool
}

// Budgets caps sends per key in UTC calendar periods. Nil means no cap; a
// pointer to 0 refuses every send. Use Limit(n).
type Budgets struct {
	PerHour  *int
	PerDay   *int
	PerMonth *int
}

// Rate caps sends per key in a sliding minute. Nil means no cap.
type Rate struct {
	PerMinute *int
}

// Limit returns &n, for Budgets and Rate fields.
func Limit(n int) *int { return &n }

// Approval decides which sends wait for a person.
type Approval struct {
	// NewRecipients holds a send when any recipient has never had a send
	// recorded by this key.
	NewRecipients bool
	// Recipients always need a person: exact addresses ("vip@bigco.com") or
	// whole domains ("@bigco.com").
	Recipients []string
	// RequireFor is your own rule. hold=true holds the send; a non-empty
	// detail is reported in the evidence.
	RequireFor func(ctx context.Context, send Send) (hold bool, detail string)
}

// Config configures a Guard. The zero Config detects loops with
// LoopDefaults and caps nothing else.
type Config struct {
	// Key is the default key for sends that name none. Default "default".
	Key      string
	Budgets  Budgets
	Rate     Rate
	Loop     Loop
	Approval Approval
	// Suppress lists exact addresses or "@domain" rules this guard never
	// sends to. Matching sends are refused, even when approved.
	Suppress []string
	// Store holds state. Default NewMemoryStore().
	Store Store
	// Clock is the time source. Default time.Now.
	Clock func() time.Time
	// Namespace prefixes every store name. Default "agent-email-guard".
	Namespace string
	// OnRecordError is told when a wrapped send went out but Record failed.
	// The send still reports success, so nobody retries a delivered email.
	OnRecordError func(error)
}

// Guard checks sends against a Config. Safe for concurrent use.
type Guard struct {
	cfg      Config
	loop     Loop
	store    Store
	clock    func() time.Time
	ns       string
	budgets  []budgetRule
	released sync.Map // *Reservation -> struct{}
	kill     *KillSwitch
}

type budgetRule struct {
	period string
	budget int
}

// New returns a Guard for cfg.
func New(cfg Config) *Guard {
	g := &Guard{cfg: cfg, loop: cfg.Loop.resolved(), store: cfg.Store, clock: cfg.Clock, ns: cfg.Namespace}
	if g.store == nil {
		g.store = NewMemoryStore()
	}
	if g.clock == nil {
		g.clock = time.Now
	}
	if g.ns == "" {
		g.ns = "agent-email-guard"
	}
	for _, b := range []struct {
		p string
		v *int
	}{{"hour", cfg.Budgets.PerHour}, {"day", cfg.Budgets.PerDay}, {"month", cfg.Budgets.PerMonth}} {
		if b.v != nil {
			g.budgets = append(g.budgets, budgetRule{b.p, *b.v})
		}
	}
	g.kill = &KillSwitch{g: g}
	return g
}

// Store returns the store the guard uses.
func (g *Guard) Store() Store { return g.store }

type approvedKey struct{}

// Approved returns a context under which Check (and wrapped send functions)
// treat the send as approved by a person.
func Approved(ctx context.Context) context.Context {
	return context.WithValue(ctx, approvedKey{}, true)
}

func isApproved(ctx context.Context, s Send) bool {
	if s.Approved {
		return true
	}
	v, _ := ctx.Value(approvedKey{}).(bool)
	return v
}

func (g *Guard) keyOf(s Send) string {
	switch {
	case s.Key != "":
		return s.Key
	case g.cfg.Key != "":
		return g.cfg.Key
	}
	return "default"
}

func (g *Guard) nowMs() int64 { return g.clock().UnixMilli() }

// ToRecord turns a send into what loop detection compares: the sorted To
// line, every recipient, and normalized subject and body.
func ToRecord(s Send, atMs int64) SendRecord {
	to := AddressList(s.To)
	recipients := append([]string{}, to...)
	seen := make(map[string]struct{}, len(to))
	for _, a := range to {
		seen[a] = struct{}{}
	}
	for _, a := range append(AddressList(s.Cc), AddressList(s.Bcc)...) {
		if _, ok := seen[a]; !ok {
			seen[a] = struct{}{}
			recipients = append(recipients, a)
		}
	}
	sorted := append([]string{}, to...)
	sort.Strings(sorted)
	body := s.Text
	if body == "" {
		body = s.HTML
	}
	nb := NormalizeText(body)
	if len(nb) > BodyCompareChars {
		nb = nb[:BodyCompareChars]
	}
	return SendRecord{ToLine: strings.Join(sorted, ","), Recipients: recipients, Subject: NormalizeText(s.Subject), Body: nb, At: atMs}
}

func matchesRule(addr, rule string) bool {
	r := NormalizeAddress(rule)
	if strings.HasPrefix(r, "@") {
		return strings.HasSuffix(addr, r)
	}
	return addr == r
}

func firstRuleMatch(addrs, rules []string) (string, string, bool) {
	for _, a := range addrs {
		for _, r := range rules {
			if matchesRule(a, r) {
				return a, NormalizeAddress(r), true
			}
		}
	}
	return "", "", false
}

// PeriodBounds returns [start, end) in epoch ms of the UTC calendar period
// ("hour", "day" or "month") containing nowMs.
func PeriodBounds(period string, nowMs int64) (int64, int64) {
	const hour, day = int64(3_600_000), int64(86_400_000)
	switch period {
	case "hour":
		s := floorDiv(nowMs, hour) * hour
		return s, s + hour
	case "day":
		s := floorDiv(nowMs, day) * day
		return s, s + day
	}
	t := time.UnixMilli(nowMs).UTC()
	start := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	return start.UnixMilli(), start.AddDate(0, 1, 0).UnixMilli()
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

var memberSeq atomic.Uint64

func newMember(now int64) string {
	var b [5]byte
	_, _ = rand.Read(b[:])
	return strconv.FormatInt(now, 10) + "-" + strconv.FormatUint(memberSeq.Add(1)%1_000_000_000, 10) + "-" + hex.EncodeToString(b[:])
}

// Reservation is what an allowed Check reserved. It serializes to JSON, so a
// queue worker can release a decision another process made.
type Reservation struct {
	Key      string            `json:"key"`
	Counters []ReservedCounter `json:"counters"`
	Window   *ReservedSlot     `json:"window"`
}

// ReservedCounter is one budget counter increment.
type ReservedCounter struct {
	Name   string `json:"name"`
	Amount int64  `json:"amount"`
}

// ReservedSlot is one rate-window member.
type ReservedSlot struct {
	Name   string `json:"name"`
	Member string `json:"member"`
}

// Check decides whether send may go out. In order, stopping at the first
// block: kill switch, suppression, loops, approval, rate ceiling, budgets
// (hour, day, month). When the outcome is Allow, Check has reserved the send
// against the rate ceiling and every budget: call Record after the provider
// accepts it, or Release if the provider fails. Nothing before the rate
// ceiling reserves anything. A non-nil error means the store failed.
func (g *Guard) Check(ctx context.Context, send Send) (Decision, error) {
	now := g.nowMs()
	key := g.keyOf(send)

	// 1. Kill switch.
	kill, err := g.kill.State(ctx)
	if err != nil {
		return Decision{}, err
	}
	if kill.Paused {
		return newDecision(Refuse, ReasonKillSwitchActive, msgKillSwitch, Evidence{
			"paused_at": kill.PausedAt.UnixMilli(), "paused_by": kill.PausedBy, "pause_reason": kill.Reason,
		}), nil
	}

	cand := ToRecord(send, now)

	// 2. Suppression.
	if a, r, ok := firstRuleMatch(cand.Recipients, g.cfg.Suppress); ok {
		return newDecision(Refuse, ReasonRecipientSuppressed, msgSuppressed(a, r), Evidence{"recipient": a, "matched_rule": r}), nil
	}

	// 3. Loops.
	ev := Evidence{"key": key}
	if g.loop.Mode != LoopOff {
		recent, err := g.store.RecentSends(ctx, g.logName(key), now-g.loop.Window.Milliseconds())
		if err != nil {
			return Decision{}, err
		}
		res := DetectLoop(recent, cand, now, g.loop)
		if res.Decision != nil {
			return *res.Decision, nil
		}
		for k, v := range res.Stats {
			ev[k] = v
		}
	}

	// 4. Approval.
	if isApproved(ctx, send) {
		ev["approved"] = true
	} else if d, held, err := g.approval(ctx, key, send, cand.Recipients); err != nil || held {
		return d, err
	}

	// 5. Rate ceiling (reserves a window slot).
	res := &Reservation{Key: key}
	if pm := g.cfg.Rate.PerMinute; pm != nil {
		name := g.ns + ":" + key + ":rate"
		member := newMember(now)
		w, err := g.store.WindowAdd(ctx, name, member, now, 60_000, int64(*pm))
		if err != nil {
			return Decision{}, err
		}
		if !w.OK {
			retry := 60
			if w.HasOldest {
				retry = int(math.Max(1, math.Ceil(float64(w.OldestAt+60_000-now)/1000)))
			}
			return newDecision(Refuse, ReasonRateCeilingExceeded, msgRateCeiling(key, *pm, retry), Evidence{
				"key": key, "sends_in_window": w.Count, "ceiling_per_minute": *pm, "retry_after_seconds": retry,
			}), nil
		}
		res.Window = &ReservedSlot{Name: name, Member: member}
		ev["rate_used"] = w.Count
		ev["rate_ceiling"] = *pm
	}

	// 6. Budgets, hour -> day -> month (each reserves one).
	for _, b := range g.budgets {
		start, end := PeriodBounds(b.period, now)
		name := g.ns + ":" + key + ":budget:" + b.period + ":" + strconv.FormatInt(start, 10)
		ceiling := int64(b.budget)
		used, ok, err := g.store.IncrementWithCeiling(ctx, name, 1, &ceiling, end)
		if err != nil {
			_ = g.giveBack(ctx, res)
			return Decision{}, err
		}
		if !ok {
			if err := g.giveBack(ctx, res); err != nil {
				return Decision{}, err
			}
			return newDecision(Refuse, ReasonAgentBudgetExceeded, msgBudget(key, b.period, b.budget, end), Evidence{
				"key": key, "period": b.period, "budget": b.budget, "used": used, "resets_at": end,
			}), nil
		}
		res.Counters = append(res.Counters, ReservedCounter{Name: name, Amount: 1})
		ev[b.period+"_used"] = used
		ev[b.period+"_budget"] = b.budget
	}

	d := newDecision(Allow, ReasonOK, msgOK, ev)
	if len(res.Counters) > 0 || res.Window != nil {
		d.reservation = res
	}
	return d, nil
}

func (g *Guard) approval(ctx context.Context, key string, send Send, recipients []string) (Decision, bool, error) {
	if a, r, ok := firstRuleMatch(recipients, g.cfg.Approval.Recipients); ok {
		return newDecision(HoldForApproval, ReasonRecipientRequiresApproval, msgApprovalRule(a, r), Evidence{
			"rule": "recipient_list", "recipient": a, "matched_rule": r,
		}), true, nil
	}
	if rf := g.cfg.Approval.RequireFor; rf != nil {
		if hold, detail := rf(ctx, send); hold {
			var d any
			if detail != "" {
				d = detail
			}
			return newDecision(HoldForApproval, ReasonRecipientRequiresApproval, msgCustomRule, Evidence{"rule": "custom", "detail": d}), true, nil
		}
	}
	if g.cfg.Approval.NewRecipients {
		var unseen []string
		for _, a := range recipients {
			n, err := g.store.GetCounter(ctx, g.seenName(key, a))
			if err != nil {
				return Decision{}, false, err
			}
			if n == 0 {
				unseen = append(unseen, a)
			}
		}
		if len(unseen) > 0 {
			return newDecision(HoldForApproval, ReasonRecipientRequiresApproval, msgNewRecipient(unseen[0], key), Evidence{
				"rule": "new_recipient", "recipient": unseen[0], "new_recipients": strings.Join(unseen, ","),
			}), true, nil
		}
	}
	return Decision{}, false, nil
}

func (g *Guard) logName(key string) string     { return g.ns + ":" + key + ":log" }
func (g *Guard) seenName(key, a string) string { return g.ns + ":" + key + ":seen:" + a }

// Record tells the guard the provider accepted send. It feeds loop detection
// and the new-recipient memory.
func (g *Guard) Record(ctx context.Context, send Send) error {
	key := g.keyOf(send)
	rec := ToRecord(send, g.nowMs())
	if err := g.store.AppendSend(ctx, g.logName(key), rec, g.loop.Window.Milliseconds()); err != nil {
		return err
	}
	for _, a := range rec.Recipients {
		if _, _, err := g.store.IncrementWithCeiling(ctx, g.seenName(key, a), 1, nil, 0); err != nil {
			return err
		}
	}
	return nil
}

// Release gives back what an allowed decision reserved, for a send the
// provider did not accept. Safe to call twice, and on any decision.
func (g *Guard) Release(ctx context.Context, d Decision) error {
	r := d.reservation
	if r == nil {
		return nil
	}
	if _, dup := g.released.LoadOrStore(r, struct{}{}); dup {
		return nil
	}
	return g.giveBack(ctx, r)
}

// ReleaseReservation gives back a reservation carried across processes as
// JSON (Decision.Reservation). It cannot tell a second call from the first.
func (g *Guard) ReleaseReservation(ctx context.Context, r *Reservation) error {
	if r == nil {
		return nil
	}
	return g.giveBack(ctx, r)
}

func (g *Guard) giveBack(ctx context.Context, r *Reservation) error {
	for _, c := range r.Counters {
		if err := g.store.Decrement(ctx, c.Name, c.Amount); err != nil {
			return err
		}
	}
	if r.Window != nil {
		return g.store.WindowRemove(ctx, r.Window.Name, r.Window.Member)
	}
	return nil
}

// SendFunc is the shape Wrap guards.
type SendFunc func(ctx context.Context, send Send) error

// Wrap returns a SendFunc with fn's signature that checks, sends, then
// records (or releases on error). A refused send returns *RefusedError, a
// held one *ApprovalRequiredError; fn is not called for either.
func (g *Guard) Wrap(fn SendFunc) SendFunc {
	w := WrapFunc(g, func(s Send) Send { return s }, func(ctx context.Context, s Send) (struct{}, error) {
		return struct{}{}, fn(ctx, s)
	})
	return func(ctx context.Context, s Send) error {
		_, err := w(ctx, s)
		return err
	}
}

// WrapFunc guards any provider call with its own request and response types:
// describe maps the request to a Send, fn sends it, and the returned function
// has fn's signature.
func WrapFunc[In, Out any](g *Guard, describe func(In) Send, fn func(context.Context, In) (Out, error)) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		var zero Out
		send := describe(in)
		d, err := g.Check(ctx, send)
		if err != nil {
			return zero, fmt.Errorf("agent-email-guard: check failed: %w", err)
		}
		switch d.Outcome {
		case Refuse:
			return zero, &RefusedError{Decision: d}
		case HoldForApproval:
			var self func(context.Context, In) (Out, error)
			self = WrapFunc(g, describe, fn)
			return zero, &ApprovalRequiredError{Decision: d, Approve: func(actx context.Context) (any, error) {
				return self(Approved(actx), in)
			}}
		}
		out, err := fn(ctx, in)
		if err != nil {
			_ = g.Release(ctx, d)
			return out, err
		}
		if rerr := g.Record(ctx, send); rerr != nil && g.cfg.OnRecordError != nil {
			g.cfg.OnRecordError(rerr)
		}
		return out, nil
	}
}

// KillSwitch returns the guard's kill switch, which stops every key.
func (g *Guard) KillSwitch() *KillSwitch { return g.kill }

// KillSwitchState is the switch's current state.
type KillSwitchState struct {
	Paused   bool
	PausedAt time.Time
	PausedBy string
	Reason   string
}

// KillSwitch stops every send through its guard. Paused never resumes on its
// own: no timer, no TTL; the only way back is Resume. The state lives in the
// Store, so every process sharing a store shares the switch.
type KillSwitch struct{ g *Guard }

type killJSON struct {
	PausedAt int64  `json:"paused_at"`
	PausedBy string `json:"paused_by"`
	Reason   string `json:"reason"`
}

func (k *KillSwitch) name() string { return k.g.ns + ":kill" }

// Pause stops every send until Resume. by names who pulled it; empty means
// "agent-email-guard".
func (k *KillSwitch) Pause(ctx context.Context, reason, by string) (KillSwitchState, error) {
	if by == "" {
		by = "agent-email-guard"
	}
	at := k.g.nowMs()
	raw, err := json.Marshal(killJSON{PausedAt: at, PausedBy: by, Reason: reason})
	if err != nil {
		return KillSwitchState{}, err
	}
	s := string(raw)
	if err := k.g.store.SetState(ctx, k.name(), &s); err != nil {
		return KillSwitchState{}, err
	}
	return KillSwitchState{Paused: true, PausedAt: time.UnixMilli(at), PausedBy: by, Reason: reason}, nil
}

// Resume re-opens sending. It returns false, and records nothing, when the
// switch was not paused. The cleared pause is kept, with who resumed it and
// when, under <namespace>:kill:last_resume.
func (k *KillSwitch) Resume(ctx context.Context, by string) (bool, error) {
	st, err := k.State(ctx)
	if err != nil || !st.Paused {
		return false, err
	}
	audit, err := json.Marshal(struct {
		PausedAt  int64  `json:"paused_at"`
		PausedBy  string `json:"paused_by"`
		Reason    string `json:"reason"`
		ResumedAt int64  `json:"resumed_at"`
		ResumedBy string `json:"resumed_by"`
	}{st.PausedAt.UnixMilli(), st.PausedBy, st.Reason, k.g.nowMs(), by})
	if err != nil {
		return false, err
	}
	a := string(audit)
	if err := k.g.store.SetState(ctx, k.name()+":last_resume", &a); err != nil {
		return false, err
	}
	if err := k.g.store.SetState(ctx, k.name(), nil); err != nil {
		return false, err
	}
	return true, nil
}

// State reads the switch from the store.
func (k *KillSwitch) State(ctx context.Context) (KillSwitchState, error) {
	raw, ok, err := k.g.store.GetState(ctx, k.name())
	if err != nil || !ok {
		return KillSwitchState{}, err
	}
	var j killJSON
	if err := json.Unmarshal([]byte(raw), &j); err != nil {
		return KillSwitchState{}, fmt.Errorf("agent-email-guard: kill switch state is not valid JSON: %w", err)
	}
	return KillSwitchState{Paused: true, PausedAt: time.UnixMilli(j.PausedAt), PausedBy: j.PausedBy, Reason: j.Reason}, nil
}
