package emailguard

import (
	"regexp"
	"strings"
)

// Normalization is ASCII-only on purpose: Unicode case folding differs
// between runtimes, and every port must compare the same strings.

func asciiLower(s string) string {
	b := []byte(s)
	changed := false
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
			changed = true
		}
	}
	if !changed {
		return s
	}
	return string(b)
}

const asciiSpace = " \t\n\r\f\v"

func asciiTrim(s string) string { return strings.Trim(s, asciiSpace) }

var angleAddr = regexp.MustCompile(`<([^<>]*)>[ \t\n\r\f\v]*$`)

// NormalizeAddress returns one address as the guard compares it: the part
// inside <...> when present, trimmed, ASCII-lowercased.
func NormalizeAddress(raw string) string {
	s := asciiTrim(raw)
	if m := angleAddr.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return asciiLower(asciiTrim(s))
}

// AddressList normalizes every address in a To, Cc or Bcc field, in order,
// dropping empties and duplicates. Each entry may hold several addresses
// separated by commas.
func AddressList(field []string) []string {
	out := make([]string, 0, len(field))
	seen := make(map[string]struct{}, len(field))
	for _, item := range field {
		for _, part := range strings.Split(item, ",") {
			a := NormalizeAddress(part)
			if a == "" {
				continue
			}
			if _, ok := seen[a]; ok {
				continue
			}
			seen[a] = struct{}{}
			out = append(out, a)
		}
	}
	return out
}

// BodyCompareChars is how much normalized body text the similarity
// comparison reads.
const BodyCompareChars = 4096

// NormalizeText ASCII-lowercases, turns every run of characters outside
// [a-z0-9] into one space, and trims.
func NormalizeText(text string) string {
	var b strings.Builder
	b.Grow(len(text))
	pending := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			if pending && b.Len() > 0 {
				b.WriteByte(' ')
			}
			pending = false
			b.WriteByte(c)
		} else {
			pending = true
		}
	}
	return b.String()
}

func trigrams(normalized string) map[string]struct{} {
	padded := "  " + normalized + " "
	grams := make(map[string]struct{}, len(padded))
	for i := 0; i+3 <= len(padded); i++ {
		grams[padded[i:i+3]] = struct{}{}
	}
	return grams
}

func jaccard(a, b map[string]struct{}) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 1
	}
	small, big := a, b
	if len(b) < len(a) {
		small, big = b, a
	}
	inter := 0
	for g := range small {
		if _, ok := big[g]; ok {
			inter++
		}
	}
	union := len(a) + len(b) - inter
	if union == 0 {
		return 1
	}
	return float64(inter) / float64(union)
}

// TextSimilarity normalizes both strings and returns the Jaccard similarity
// of their character trigrams, 0..1.
func TextSimilarity(a, b string) float64 {
	na, nb := NormalizeText(a), NormalizeText(b)
	if na == nb {
		return 1
	}
	return jaccard(trigrams(na), trigrams(nb))
}
