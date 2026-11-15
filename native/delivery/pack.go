package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

// Per-moment sizes (sheet 30, Budgets). Estimated tokens.
const (
	momentTarget  = 200
	momentCeiling = 600
	reservedLane  = 400
	sessionFactor = 3
)

// The rising bar of the online knapsack policy (Zhou, Chakrabarty and Lukose,
// 2008): psi(z) = (U*e/L)^z * (L/e), z the share of the epoch budget used.
// L admits the weakest initial prompt item (and a weakest-evidence command
// of 600 tokens). U admits only the strongest exact matches near saturation.
const (
	barLow = 1.0 / 6000.0 * math.E
	// Saturation boundary: person-backed exact file, two path segments,
	// 20 estimated tokens. Stronger specificity remains lexicographically prior.
	barHigh = patternBand * (2 + .0001*(3*257+2) + .000001/2)
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
	parent     string
}

// pack orders and sizes one reply: failure fixes first, then the strongest
// trigger; full form for the first item, one-line after; a per-moment ceiling
// that only companions may exceed. Items that don't fit are logged as held
// back, never cut mid-text.
func pack(items []shaped, companions func(id string) *shaped, scorers ...Scorer) []planned {
	var scorer Scorer = tiersScorer{}
	if len(scorers) > 0 {
		scorer = scorers[0]
	}
	sort.SliceStable(items, func(i, j int) bool { return scorer.Less(items[i], items[j]) })
	var out []planned
	seen := map[string]bool{}
	used, reserved := 0, 0
	markerPaid := false
	for _, s := range items {
		id := s.item.Entry.ID
		if seen[id] {
			continue
		}
		seen[id] = true
		p := planned{shaped: s}
		if s.action == "withheld" || s.action == "held-back" {
			out = append(out, p)
			continue
		}
		duplicate := false
		for _, prior := range out {
			if !prior.heldBack && prior.action != "withheld" && itemSimilar(s.item, prior.item) {
				duplicate = true
				break
			}
		}
		if duplicate {
			p.action, p.detail = "withheld", "similar"
			out = append(out, p)
			continue
		}
		limit, spent := momentCeiling, &used
		if s.reserve {
			limit, spent = reservedLane, &reserved
		}
		overhead := entries.EstimateTokens(" (" + id + ")")
		if !markerPaid {
			overhead += 8
		}
		fullCost, lineCost := s.fullTok+overhead, s.lineTok+overhead
		if s.fullTok > 0 && fullCost <= limit-*spent && (*spent+fullCost <= momentTarget || *spent == 0 || s.reserve || s.action == "replaced") {
			p.form, p.text, p.tokens = "full", s.full, fullCost
		} else if s.lineTok > 0 && lineCost <= limit-*spent {
			p.form, p.text, p.tokens = "one-line", s.oneLine, lineCost
		} else {
			p.form, p.tokens, p.heldBack = "one-line", lineCost, true
			out = append(out, p)
			continue
		}
		if s.action == "replaced" && s.item.Entry.Kind == "fact" {
			p.form = "pointer"
		}
		*spent += p.tokens
		markerPaid = true
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
				c.reserve, c.exempt = out[i].reserve, out[i].exempt
				out = append(out, planned{shaped: *c, form: "one-line", text: c.oneLine, tokens: c.lineTok + entries.EstimateTokens(" ("+cid+")"), parent: out[i].item.Entry.ID})
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
		c := record.DeliveryCandidate{EntryID: p.item.Entry.ID, Moment: p.moment, Form: p.form, Tokens: p.tokens, Reserved: p.reserve, Exempt: p.exempt, Resend: p.resend, ContentHash: contentHash(p.item.Hash + "\n" + p.text)}
		c.Surface = record.SurfaceForMoment(p.moment)
		if p.parent != "" {
			for _, parent := range plan {
				if parent.item.Entry.ID == p.parent {
					c.Surface = record.SurfaceForMoment(parent.moment)
					break
				}
			}
		}
		c.Detail, c.Parent = p.detail, p.parent
		c.Title, c.Kind, c.Level = p.item.Entry.OneLine, p.item.Entry.Kind, p.item.Level
		switch {
		case p.correction:
			c.Correction, c.Moment, c.Form = true, "correction", "one-line"
		case p.action == "withheld":
			c.Action, c.Form, c.Tokens = "withheld", "one-line", 0
		case p.heldBack:
			c.Action = "held-back"
			c.Detail = "moment-budget"
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
func admit(plan []planned, scorers ...Scorer) func(record.Epoch, record.DeliveryCandidate) bool {
	var scorer Scorer = tiersScorer{}
	if len(scorers) > 0 {
		scorer = scorers[0]
	}
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
		return scorer.BudgetOnly() || scorer.Value(p.shaped, c.Tokens) >= bar(z)
	}
}

// render builds the one context block of a reply from what the ledger gave.
func render(block string, plan []planned, receipts []record.Receipt) string {
	given := map[string]bool{}
	corrected := map[string]bool{}
	for _, r := range receipts {
		switch {
		case r.Correction && r.Action != "shadow":
			corrected[r.EntryID] = true
		case r.Action == "given" || r.Action == "replaced":
			given[r.EntryID] = true
		}
	}
	var b strings.Builder
	for _, p := range plan {
		id := p.item.Entry.ID
		switch {
		case p.correction && corrected[id] && p.text != "":
			b.WriteString(strings.TrimSpace(p.text) + " (" + id + ")\n")
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
