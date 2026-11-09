package emailguard

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"
)

// PolicyFile is the conventional name of the policy file: the declarative
// part of a Config in the snake_case keys every port reads, so one file
// configures the Node, Python, PHP and Go guards alike.
const PolicyFile = "agent-email-guard.json"

type leafKind int

const (
	kAny leafKind = iota
	kInt
	kNum
	kBool
	kStr
	kStrs
	kMode
	kOne
)

var policyShape = map[string]any{
	"$schema":   kAny,
	"$comment":  kAny,
	"version":   kOne,
	"key":       kStr,
	"namespace": kStr,
	"budgets":   map[string]leafKind{"per_hour": kInt, "per_day": kInt, "per_month": kInt},
	"rate":      map[string]leafKind{"per_minute": kInt},
	"loop": map[string]leafKind{
		"mode": kMode, "window_ms": kInt, "similarity_threshold": kNum, "max_identical_sends": kInt,
		"min_window_for_entropy": kInt, "recipient_perplexity_floor": kNum,
	},
	"approval": map[string]leafKind{"new_recipients": kBool, "recipients": kStrs},
	"suppress": kStrs,
}

type kv struct {
	k string
	v any
}

// decodeOrdered decodes one JSON value, keeping object keys in file order so
// problems are reported in the order the file lists them.
func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			var obj []kv
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				obj = append(obj, kv{kt.(string), v})
			}
			_, err := dec.Token()
			return obj, err
		case '[':
			var arr []any
			for dec.More() {
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			_, err := dec.Token()
			return arr, err
		}
	}
	return tok, nil
}

func leafOK(kind leafKind, v any) bool {
	num := func() (float64, bool) {
		n, ok := v.(json.Number)
		if !ok {
			return 0, false
		}
		f, err := n.Float64()
		return f, err == nil && !math.IsInf(f, 0)
	}
	switch kind {
	case kInt:
		f, ok := num()
		return ok && f == math.Trunc(f) && f >= 0
	case kNum:
		f, ok := num()
		return ok && f > 0
	case kBool:
		_, ok := v.(bool)
		return ok
	case kStr:
		s, ok := v.(string)
		return ok && s != ""
	case kStrs:
		arr, ok := v.([]any)
		if !ok {
			return false
		}
		for _, x := range arr {
			if _, ok := x.(string); !ok {
				return false
			}
		}
		return true
	case kMode:
		s, _ := v.(string)
		return s == string(LoopFull) || s == string(LoopRepetitionOnly) || s == string(LoopOff)
	case kOne:
		f, ok := num()
		return ok && f == 1
	}
	return true
}

// ValidatePolicy returns every problem with a policy file, as sentences.
// Empty means valid.
func ValidatePolicy(data []byte) []string {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	root, err := decodeOrdered(dec)
	if err == nil {
		if _, extra := dec.Token(); extra != io.EOF {
			err = errors.New("trailing data")
		}
	}
	if err != nil {
		return []string{"The policy is not valid JSON."}
	}
	obj, ok := root.([]kv)
	if !ok {
		return []string{"The policy must be a JSON object."}
	}
	var problems []string
	for _, e := range obj {
		shape, known := policyShape[e.k]
		switch {
		case !known:
			problems = append(problems, fmt.Sprintf("Unknown key \"%s\".", e.k))
		case shapeIsLeaf(shape):
			if !leafOK(shape.(leafKind), e.v) {
				problems = append(problems, fmt.Sprintf("\"%s\" has the wrong type.", e.k))
			}
		default:
			inner, ok := e.v.([]kv)
			if !ok {
				problems = append(problems, fmt.Sprintf("\"%s\" must be an object.", e.k))
				continue
			}
			leaves := shape.(map[string]leafKind)
			for _, e2 := range inner {
				leaf, known := leaves[e2.k]
				if !known {
					problems = append(problems, fmt.Sprintf("Unknown key \"%s.%s\".", e.k, e2.k))
				} else if !leafOK(leaf, e2.v) {
					problems = append(problems, fmt.Sprintf("\"%s.%s\" has the wrong type.", e.k, e2.k))
				}
			}
		}
	}
	return problems
}

func shapeIsLeaf(s any) bool { _, ok := s.(leafKind); return ok }

type policyJSON struct {
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
	} `json:"approval"`
	Suppress []string `json:"suppress"`
}

// ParsePolicy turns a policy file into a Config. A file with an unknown key
// or a wrong type is rejected whole, with every problem named. RequireFor,
// the store and the clock stay in code: set them on the returned Config.
func ParsePolicy(data []byte) (Config, error) {
	if problems := ValidatePolicy(data); len(problems) > 0 {
		return Config{}, fmt.Errorf("Invalid agent-email-guard policy: %s", strings.Join(problems, " "))
	}
	var p policyJSON
	if err := json.Unmarshal(data, &p); err != nil {
		return Config{}, err
	}
	c := Config{Key: p.Key, Namespace: p.Namespace, Suppress: p.Suppress}
	if b := p.Budgets; b != nil {
		c.Budgets = Budgets{PerHour: b.PerHour, PerDay: b.PerDay, PerMonth: b.PerMonth}
	}
	if r := p.Rate; r != nil {
		c.Rate = Rate{PerMinute: r.PerMinute}
	}
	if l := p.Loop; l != nil {
		c.Loop = Loop{Mode: l.Mode, Window: time.Duration(l.WindowMs) * time.Millisecond, SimilarityThreshold: l.SimilarityThreshold,
			MaxIdenticalSends: l.MaxIdenticalSends, MinWindowForEntropy: l.MinWindowForEntropy, RecipientPerplexityFloor: l.RecipientPerplexityFloor}
	}
	if a := p.Approval; a != nil {
		c.Approval = Approval{NewRecipients: a.NewRecipients, Recipients: a.Recipients}
	}
	return c, nil
}

// LoadPolicy reads and parses a policy file, such as PolicyFile.
func LoadPolicy(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	return ParsePolicy(data)
}
