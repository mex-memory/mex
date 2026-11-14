package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/record"
)

// Per-moment sizes (sheet 30, Budgets). Estimated tokens.
const (
	momentTarget  = 200
	momentCeiling = 600
	reservedLane  = 400
	sessionFactor = 3
)

var tierWeight = map[int]float64{tierPattern: 16, tierCommand: 8, tierFile: 4, tierFolder: 2, tierPrompt: 1}

var evidenceWeight = map[string]float64{"person": 6, "ci": 5, "docs": 4, "review": 3, "mined": 2, "observed": 1}

// value is value per token: trigger strength, then evidence, over cost.
// delivery-02 replaces this function; nothing else depends on its scale
// except barLow and barHigh below.
func value(s shaped, tokens int) float64 {
	if tokens < 1 {
		tokens = 1
	}
	e := evidenceWeight[s.item.Entry.Evidence]
	if e == 0 {
		e = 1
	}
	if s.item.Level == "personal" && s.item.Entry.Source.Type == "person" {
		e = evidenceWeight["person"]
	}
	return tierWeight[s.tier] * e / float64(tokens)
}

// The rising bar of the online knapsack policy (Zhou, Chakrabarty and Lukose,
// 2008): psi(z) = (U*e/L)^z * (L/e), z the share of the epoch budget used.
// L is chosen so that at z=0 a command-tier item of 600 tokens with the
// weakest evidence still passes (8*1/600); U is about the best value per token
// (16*6/20).
const (
	barLow  = 8.0 / 600.0 * math.E
	barHigh = 5.0
)

func bar(z float64) float64 {
	if z < 0 {
		z = 0
	}
	if z > 1 {
		z = 1
	}
	return math.Pow(barHigh*math.E/barLow, z) * (barLow / math.E)
}

type planned struct {
	shaped
	form       string // full or one-line (pointer and re-derived replies use full)
	text       string
	tokens     int
	correction bool
	heldBack   bool
}

// pack orders and sizes one reply: failure fixes first, then the strongest
// trigger; full form for the first item, one-line after; a per-moment ceiling
// that only companions may exceed. Items that don't fit are logged as held
// back, never cut mid-text.
func pack(items []shaped, companions func(id string) *shaped) []planned {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.reserve != b.reserve {
			return a.reserve
		}
		if a.tier != b.tier {
			return a.tier < b.tier
		}
		ea, eb := evidenceWeight[a.item.Entry.Evidence], evidenceWeight[b.item.Entry.Evidence]
		if ea != eb {
			return ea > eb
		}
		if a.lineTok != b.lineTok {
			return a.lineTok < b.lineTok
		}
		return a.item.Entry.ID < b.item.Entry.ID
	})
	var out []planned
	seen := map[string]bool{}
	used, reserved, fulls := 0, 0, 0
	for _, s := range items {
		id := s.item.Entry.ID
		if seen[id] {
			continue
		}
		seen[id] = true
		p := planned{shaped: s}
		if s.action == "withheld" {
			out = append(out, p)
			continue
		}
		limit, spent := momentCeiling, &used
		if s.reserve {
			limit, spent = reservedLane, &reserved
		}
		if s.fullTok > 0 && s.fullTok <= limit-*spent && (fulls == 0 || s.reserve || s.action == "replaced") {
			p.form, p.text, p.tokens = "full", s.full, s.fullTok
			if !s.reserve && s.action != "replaced" {
				fulls++
			}
		} else if s.lineTok > 0 && s.lineTok <= limit-*spent {
			p.form, p.text, p.tokens = "one-line", s.oneLine, s.lineTok
		} else {
			p.form, p.tokens, p.heldBack = "one-line", s.lineTok, true
			out = append(out, p)
			continue
		}
		if s.action == "replaced" && s.item.Entry.Kind == "fact" {
			p.form = "pointer"
		}
		*spent += p.tokens
		out = append(out, p)
	}
	// Companions travel with what was chosen, in one-line form.
	if companions != nil {
		n := len(out)
		for i := 0; i < n; i++ {
			if out[i].heldBack || out[i].action == "withheld" {
				continue
			}
			for _, cid := range out[i].item.Entry.Companions {
				if seen[cid] || len(out) >= 32 {
					continue
				}
				c := companions(cid)
				if c == nil || c.action == "withheld" || c.lineTok == 0 {
					continue
				}
				seen[cid] = true
				c.reserve = false
				out = append(out, planned{shaped: *c, form: "one-line", text: c.oneLine, tokens: c.lineTok})
			}
		}
	}
	return out
}

func contentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// requestCandidates turns a plan into ledger candidates, in render order.
func requestCandidates(plan []planned) []record.DeliveryCandidate {
	var out []record.DeliveryCandidate
	for _, p := range plan {
		c := record.DeliveryCandidate{EntryID: p.item.Entry.ID, Moment: p.moment, Form: p.form, Tokens: p.tokens, Reserved: p.reserve, Exempt: p.exempt, ContentHash: contentHash(p.item.Hash + "\n" + p.text)}
		switch {
		case p.correction:
			c.Correction, c.Moment, c.Form = true, "correction", "one-line"
		case p.action == "withheld":
			c.Action, c.Form, c.Tokens = "withheld", "one-line", 0
		case p.heldBack:
			c.Action = "held-back"
		default:
			c.Action = p.action
		}
		if c.Form == "" {
			c.Form = "one-line"
		}
		out = append(out, c)
	}
	return out
}

// admit applies the rising bar under the ledger's lock. Past the session
// ceiling the bar sits half a budget higher: harder, never closed.
func admit(plan []planned) func(record.Epoch, record.DeliveryCandidate) bool {
	byID := map[string]planned{}
	for _, p := range plan {
		byID[p.item.Entry.ID] = p
	}
	return func(e record.Epoch, c record.DeliveryCandidate) bool {
		p, ok := byID[c.EntryID]
		if !ok || e.Budget <= 0 {
			return false
		}
		z := float64(e.TokensSent) / float64(e.Budget)
		if e.SessionTokens > sessionFactor*e.Budget {
			z += 0.5
		}
		return value(p.shaped, c.Tokens) >= bar(z)
	}
}

// render builds the one context block of a reply from what the ledger gave.
func render(block string, plan []planned, receipts []record.Receipt) string {
	given := map[string]bool{}
	corrected := map[string]bool{}
	for _, r := range receipts {
		switch {
		case r.Correction:
			corrected[r.EntryID] = true
		case r.Action == "given" || r.Action == "replaced":
			given[r.EntryID] = true
		}
	}
	var b strings.Builder
	for _, p := range plan {
		id := p.item.Entry.ID
		switch {
		case p.correction && corrected[id]:
			b.WriteString("Correction: the MEX note " + id + " given earlier no longer matches the code; set it aside.\n")
		case !p.correction && given[id] && p.text != "":
			b.WriteString(strings.TrimSpace(p.text))
			b.WriteString(" (" + id + ")\n")
		}
	}
	if b.Len() == 0 {
		return ""
	}
	return "[mex " + block + "]\n" + strings.TrimRight(b.String(), "\n")
}
