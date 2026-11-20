package delivery

// Pattern monitoring (plan sheet 31): a pattern that never fired in 90 days
// is listed in `mex report`, never deleted; one that fires often with no
// violation moves to the area digest. The delivery ledger keeps 30 days, so
// the monitor keeps its own small record per project:
// <record directory>/projects/<project>/pattern-monitor.json.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

const (
	// monitorWindow: firings and violations are counted over this window.
	monitorWindow = 30 * 24 * time.Hour
	// digestFirings: this many firings in the window with no violation
	// move a pattern to the digest. The plan says "often"; this is the
	// starting value.
	digestFirings = 10
	monitorBytes  = 1 << 20
	monitorDate   = "2006-01-02"
)

// PatternMonitor is the monitor's file. The Node side reads it for
// `mex report`; keep the field names stable.
type PatternMonitor struct {
	Version int                         `json:"version"`
	Entries map[string]*PatternActivity `json:"entries"`
}

type PatternActivity struct {
	LastFired     string `json:"last_fired,omitempty"`     // date
	LastViolation string `json:"last_violation,omitempty"` // date
	Window        string `json:"window"`                   // date the counts start
	Fired         int    `json:"fired"`
	Violations    int    `json:"violations"`
}

func monitorPath(recordDirectory, project string) string {
	return filepath.Join(recordDirectory, "projects", project, "pattern-monitor.json")
}

func loadMonitor(recordDirectory, project string) *PatternMonitor {
	m := &PatternMonitor{Version: 1, Entries: map[string]*PatternActivity{}}
	if recordDirectory == "" || project == "" {
		return m
	}
	data, err := os.ReadFile(monitorPath(recordDirectory, project))
	if err != nil || len(data) > monitorBytes {
		return m
	}
	var read PatternMonitor
	if json.Unmarshal(data, &read) == nil && read.Version == 1 && read.Entries != nil {
		return &read
	}
	return m
}

// note counts one firing or violation for an entry, starting a new window
// when the current one is over.
func (m *PatternMonitor) note(id string, fired, violated bool, now time.Time) {
	a := m.Entries[id]
	day := now.UTC().Format(monitorDate)
	if a == nil {
		a = &PatternActivity{Window: day}
		m.Entries[id] = a
	}
	if start, err := time.Parse(monitorDate, a.Window); err != nil || now.Sub(start) > monitorWindow {
		a.Window, a.Fired, a.Violations = day, 0, 0
	}
	if fired {
		a.Fired++
		a.LastFired = day
	}
	if violated {
		a.Violations++
		a.LastViolation = day
	}
}

// demoted: fired often in the current window and never violated in it.
func (m *PatternMonitor) demoted(id string, now time.Time) bool {
	a := m.Entries[id]
	if a == nil || a.Violations > 0 || a.Fired < digestFirings {
		return false
	}
	start, err := time.Parse(monitorDate, a.Window)
	return err == nil && now.Sub(start) <= monitorWindow
}

func (m *PatternMonitor) save(recordDirectory, project string) error {
	if recordDirectory == "" || project == "" {
		return nil
	}
	file := monitorPath(recordDirectory, project)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(m)
	if err != nil || len(data) > monitorBytes {
		return fmt.Errorf("pattern monitor too large")
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// noteViolation records a violation outside delivery (a speed bump stop).
func noteViolation(recordDirectory, project, id string, now time.Time) {
	if now.IsZero() {
		now = time.Now()
	}
	m := loadMonitor(recordDirectory, project)
	m.note(id, false, true, now)
	_ = m.save(recordDirectory, project)
}

const (
	momentDigest = "digest"
	// digestTokens caps one area digest (plan sheet 29: about 120 tokens).
	digestTokens = 120
	// digestLabelTokens: the "[team, from a person]" label and "(mx_id)".
	digestLabelTokens = 16
)

// monitorGroup counts this call's pattern firings and violations for one
// checkout, takes demoted patterns out of their pattern moments and offers
// them as the area digest instead: one line each, at most digestTokens, at
// the first read or edit in their area this epoch (the ledger dedupes).
func monitorGroup(env Environment, g *group) {
	if g == nil || g.snap == nil || env.RecordDirectory == "" || len(g.views) == 0 {
		return
	}
	patterned := false
	for i := range g.snap.Items {
		if len(g.snap.Items[i].Entry.When) > 0 {
			patterned = true
			break
		}
	}
	if !patterned {
		return
	}
	now := env.Now
	if now.IsZero() {
		now = time.Now()
	}
	fired, violated := map[string]bool{}, map[string]bool{}
	for _, c := range g.cands {
		if c.moment == momentReadRisk || c.moment == momentRejected {
			fired[c.item.Entry.ID] = true
		}
	}
	shell := map[string]bool{}
	for _, rel := range g.shellEdits {
		shell[rel] = true
	}
	for _, c := range g.cands {
		if c.moment == momentEdit && c.tier == tierPattern && shell[c.rel] {
			violated[c.item.Entry.ID] = true // a shell edit that broke it
		}
	}
	p := g.snap.Patterns()
	for _, v := range g.views {
		if !isEdit(v) {
			continue
		}
		added, removed := boundedText(v.added, 32768), boundedText(v.removed, 32768)
		for i := range g.snap.Items {
			it := &g.snap.Items[i]
			if inScope(it, v.rel) && p.InEdit(added, it, "anti") && !p.InEdit(removed, it, "anti") {
				violated[it.Entry.ID] = true // an edit that added the anti-pattern
			}
		}
	}
	m := loadMonitor(env.RecordDirectory, g.project)
	kept := g.cands[:0]
	for _, c := range g.cands {
		if c.moment == momentReadRisk && m.demoted(c.item.Entry.ID, now) && !violated[c.item.Entry.ID] {
			continue // fires often and is never broken: the digest carries it
		}
		kept = append(kept, c)
	}
	g.cands = kept
	tokens := 0
	for i := range g.snap.Items {
		it := &g.snap.Items[i]
		if !m.demoted(it.Entry.ID, now) || violated[it.Entry.ID] {
			continue
		}
		for _, v := range g.views {
			if v.rel == "" || (v.name != contract.ToolRead && !isEdit(v)) || !inScope(it, v.rel) {
				continue
			}
			// The rendered line carries a label and the id; a light snapshot
			// may count neither, so take the larger of the two estimates.
			cost := max(it.OneLineTokens, entries.EstimateTokens(it.Entry.OneLine)+digestLabelTokens)
			if tokens+cost > digestTokens {
				break
			}
			tokens += cost
			g.cands = append(g.cands, candidate{item: it, moment: momentDigest, tier: tierFolder, rel: v.rel, lineOnly: true})
			break
		}
	}
	if len(fired) == 0 && len(violated) == 0 {
		return
	}
	for id := range fired {
		m.note(id, true, violated[id], now)
	}
	for id := range violated {
		if !fired[id] {
			m.note(id, false, true, now)
		}
	}
	_ = m.save(env.RecordDirectory, g.project)
}
