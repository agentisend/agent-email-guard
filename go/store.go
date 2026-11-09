package emailguard

import (
	"context"
	"sync"
)

// SendRecord is one accepted send as loop detection compares it. Text fields
// are already normalized. Times are epoch milliseconds so every port and
// every store backend agrees on them.
type SendRecord struct {
	// ToLine is the sorted, comma-joined To addresses. Repetition compares it.
	ToLine string `json:"to_line"`
	// Recipients is every address the send reached (To, Cc, Bcc). Entropy
	// counts these.
	Recipients []string `json:"recipients"`
	// Subject is NormalizeText(subject).
	Subject string `json:"subject"`
	// Body is NormalizeText(body), cut to BodyCompareChars.
	Body string `json:"body"`
	// At is epoch milliseconds.
	At int64 `json:"at"`
}

// WindowResult is the outcome of Store.WindowAdd.
type WindowResult struct {
	OK bool
	// Count is the members inside the window after the call.
	Count int64
	// OldestAt is the epoch ms of the oldest member still inside the window;
	// HasOldest is false when the window is empty.
	OldestAt  int64
	HasOldest bool
}

// Store holds the guard's state. IncrementWithCeiling and WindowAdd MUST each
// be ONE atomic step (a Lua script, a conditional UPDATE, a mutex), never
// read-then-write: two callers racing at used = budget-1 must not both get
// through. MemoryStore covers one process; the redisstore and pgstore
// modules share state across processes.
type Store interface {
	// IncrementWithCeiling: if value+amount <= ceiling (or ceiling is nil),
	// add amount and return (new value, true); otherwise change nothing and
	// return (current value, false). A missing counter is 0. expiresAt is
	// epoch ms after which the backend may drop the counter; 0 means never.
	IncrementWithCeiling(ctx context.Context, name string, amount int64, ceiling *int64, expiresAt int64) (value int64, ok bool, err error)
	// Decrement subtracts amount, never below 0.
	Decrement(ctx context.Context, name string, amount int64) error
	// GetCounter reads a counter; missing is 0.
	GetCounter(ctx context.Context, name string) (int64, error)
	// WindowAdd is a sliding window, atomically: drop members with
	// at-memberAt >= windowMs; if fewer than ceiling remain, add (member, at).
	WindowAdd(ctx context.Context, name, member string, at, windowMs, ceiling int64) (WindowResult, error)
	// WindowRemove drops one member.
	WindowRemove(ctx context.Context, name, member string) error
	// AppendSend adds to a key's send log. Entries more than keepMs older
	// than record.At may be dropped.
	AppendSend(ctx context.Context, log string, record SendRecord, keepMs int64) error
	// RecentSends returns every logged send with At >= since, oldest first.
	RecentSends(ctx context.Context, log string, since int64) ([]SendRecord, error)
	// GetState reads a small string value; ok is false when unset.
	GetState(ctx context.Context, name string) (value string, ok bool, err error)
	// SetState writes it; nil deletes it.
	SetState(ctx context.Context, name string, value *string) error
}

// SendLogCap is the most entries a send log keeps per key.
const SendLogCap = 10_000

// MemoryStore is the default Store: one process, nothing shared, safe for
// concurrent use. Two processes with their own MemoryStore enforce two
// separate budgets; use redisstore or pgstore for that.
type MemoryStore struct {
	mu       sync.Mutex
	counters map[string]int64
	windows  map[string]map[string]int64
	logs     map[string][]SendRecord
	state    map[string]string
}

// NewMemoryStore returns an empty in-process store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		counters: map[string]int64{},
		windows:  map[string]map[string]int64{},
		logs:     map[string][]SendRecord{},
		state:    map[string]string{},
	}
}

var _ Store = (*MemoryStore)(nil)

// IncrementWithCeiling implements Store. Expiry is not enforced in memory:
// budget counter names carry their period, so a stale one is never read.
func (m *MemoryStore) IncrementWithCeiling(_ context.Context, name string, amount int64, ceiling *int64, _ int64) (int64, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur := m.counters[name]
	if ceiling != nil && cur+amount > *ceiling {
		return cur, false, nil
	}
	m.counters[name] = cur + amount
	return cur + amount, true, nil
}

// Decrement implements Store.
func (m *MemoryStore) Decrement(_ context.Context, name string, amount int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.counters[name]
	if !ok {
		return nil
	}
	cur -= amount
	if cur < 0 {
		cur = 0
	}
	m.counters[name] = cur
	return nil
}

// GetCounter implements Store.
func (m *MemoryStore) GetCounter(_ context.Context, name string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.counters[name], nil
}

// WindowAdd implements Store.
func (m *MemoryStore) WindowAdd(_ context.Context, name, member string, at, windowMs, ceiling int64) (WindowResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	win := m.windows[name]
	if win == nil {
		win = map[string]int64{}
		m.windows[name] = win
	}
	var oldest int64
	has := false
	for mem, t := range win {
		if at-t >= windowMs {
			delete(win, mem)
			continue
		}
		if !has || t < oldest {
			oldest, has = t, true
		}
	}
	if int64(len(win)) >= ceiling {
		return WindowResult{OK: false, Count: int64(len(win)), OldestAt: oldest, HasOldest: has}, nil
	}
	win[member] = at
	if !has {
		oldest, has = at, true
	}
	return WindowResult{OK: true, Count: int64(len(win)), OldestAt: oldest, HasOldest: has}, nil
}

// WindowRemove implements Store.
func (m *MemoryStore) WindowRemove(_ context.Context, name, member string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.windows[name], member)
	return nil
}

// AppendSend implements Store.
func (m *MemoryStore) AppendSend(_ context.Context, log string, record SendRecord, keepMs int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := append(m.logs[log], record)
	drop := 0
	for drop < len(list) && record.At-list[drop].At > keepMs {
		drop++
	}
	if len(list)-drop > SendLogCap {
		drop = len(list) - SendLogCap
	}
	if drop > 0 {
		list = append([]SendRecord(nil), list[drop:]...)
	}
	m.logs[log] = list
	return nil
}

// RecentSends implements Store.
func (m *MemoryStore) RecentSends(_ context.Context, log string, since int64) ([]SendRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SendRecord, 0, len(m.logs[log]))
	for _, r := range m.logs[log] {
		if r.At >= since {
			out = append(out, r)
		}
	}
	return out, nil
}

// GetState implements Store.
func (m *MemoryStore) GetState(_ context.Context, name string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.state[name]
	return v, ok, nil
}

// SetState implements Store.
func (m *MemoryStore) SetState(_ context.Context, name string, value *string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if value == nil {
		delete(m.state, name)
	} else {
		m.state[name] = *value
	}
	return nil
}
