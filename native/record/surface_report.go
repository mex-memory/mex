package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/mex-memory/mex/native/internal/safefile"
)

type SurfaceCount struct {
	Receipts int `json:"receipts"`
	Firings  int `json:"firings"`
	Settled  int `json:"settled"`
	Acted    int `json:"acted"`
	Tokens   int `json:"estimatedTokens"`
}
type SurfaceSummary struct {
	Surface           string       `json:"surface"`
	Live              SurfaceCount `json:"live"`
	Shadow            SurfaceCount `json:"shadow"`
	HeldBack          SurfaceCount `json:"heldBack"`
	Control           SurfaceCount `json:"control"`
	First             SurfaceCount `json:"first"`
	Repeat            SurfaceCount `json:"repeat"`
	ActedRate         *float64     `json:"actedRate"`
	BaseKind          string       `json:"baseKind"`
	BaseRate          *float64     `json:"baseRate"`
	FalseSendEstimate int          `json:"falseSendEstimate"`
	Gate              string       `json:"gate"`
	Reason            string       `json:"reason"`
}
type SurfaceReport struct {
	Surfaces   []SurfaceSummary `json:"surfaces"`
	Contention ContentionReport `json:"contention"`
}

func addCount(a *SurfaceCount, b SurfaceCount) {
	a.Receipts += b.Receipts
	a.Firings += b.Firings
	a.Settled += b.Settled
	a.Acted += b.Acted
	a.Tokens += b.Tokens
}
func rate(c SurfaceCount) *float64 {
	if c.Settled == 0 {
		return nil
	}
	r := float64(c.Acted) / float64(c.Settled)
	return &r
}
func surfaceSummary(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, project, checkout string) (SurfaceReport, error) {
	report := SurfaceReport{Surfaces: []SurfaceSummary{}}
	var err error
	report.Contention, err = contentionSummary(ctx, q, project, checkout)
	if err != nil {
		return report, err
	}
	rows, err := q.QueryContext(ctx, `SELECT surface,action,repeated,sum(firings),sum(settled),sum(acted),sum(tokens),sum(receipts) FROM surface_stats WHERE project_id=? AND (?='' OR checkout=?) GROUP BY surface,action,repeated`, project, checkout, checkout)
	if err != nil {
		return report, err
	}
	byID := map[string]*SurfaceSummary{}
	for _, id := range SurfaceIDs() {
		byID[id] = &SurfaceSummary{Surface: id, Gate: "collecting", Reason: "insufficient settled live firings", BaseKind: "none"}
	}
	for rows.Next() {
		var id, action string
		var repeat int
		var count SurfaceCount
		if err = rows.Scan(&id, &action, &repeat, &count.Firings, &count.Settled, &count.Acted, &count.Tokens, &count.Receipts); err != nil {
			break
		}
		s := byID[id]
		if s == nil {
			continue
		}
		switch action {
		case "given", "replaced":
			addCount(&s.Live, count)
		case "shadow":
			addCount(&s.Shadow, count)
		case "held-back":
			addCount(&s.HeldBack, count)
		case "control":
			addCount(&s.Control, count)
		}
		if action == "given" || action == "replaced" || action == "shadow" {
			if repeat == 0 {
				addCount(&s.First, count)
			} else {
				addCount(&s.Repeat, count)
			}
		}
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return report, err
	}
	rows, err = q.QueryContext(ctx, `SELECT surface,state,reason FROM surface_gates WHERE project_id=?`, project)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var id, state, reason string
		if err = rows.Scan(&id, &state, &reason); err != nil {
			break
		}
		if s := byID[id]; s != nil {
			s.Gate, s.Reason = state, reason
		}
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return report, err
	}
	for _, id := range SurfaceIDs() {
		s := byID[id]
		combined := s.Live
		addCount(&combined, s.Shadow)
		s.ActedRate = rate(combined)
		s.FalseSendEstimate = combined.Settled - combined.Acted
		switch {
		case s.Shadow.Settled > 0:
			s.BaseKind, s.BaseRate = "shadow", rate(s.Shadow)
		case s.HeldBack.Settled > 0:
			s.BaseKind, s.BaseRate = "held-back", rate(s.HeldBack)
		case s.Control.Settled > 0:
			s.BaseKind, s.BaseRate = "time-matched-suppressed", rate(s.Control)
		}
		report.Surfaces = append(report.Surfaces, *s)
	}
	return report, nil
}

// ReadSurfaces is read-only and never creates or migrates a local record.
func ReadSurfaces(file, project, checkout string) (SurfaceReport, error) {
	empty := SurfaceReport{Surfaces: []SurfaceSummary{}}
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return empty, nil
	}
	if !safefile.Regular(file) {
		return empty, errors.New("redirected hooks database")
	}
	db, err := openDatabase(file, true)
	if err != nil {
		return empty, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), ReaderOperationTimeout)
	defer cancel()
	version, err := schemaVersion(ctx, db)
	if err != nil {
		return empty, err
	}
	if version > SchemaVersion {
		return empty, futureSchema("hooks.db", version)
	}
	if version < 7 {
		return empty, nil
	}
	return surfaceSummary(ctx, db, project, checkout)
}

// Evaluate in disjoint batches of at least thirty new settled live firings.
// Re-reading a report or replaying saved sessions never advances the gate.
func evaluateSurfaceGates(ctx context.Context, c *sql.Conn, project string) ([]string, error) {
	rows, err := c.QueryContext(ctx, `SELECT surface,evaluated,failures,state,evaluated_acted,evaluated_first,evaluated_first_acted,evaluated_repeat,evaluated_repeat_acted FROM surface_gates WHERE project_id=? AND state<>'off'`, project)
	if err != nil {
		return nil, err
	}
	type gate struct {
		id, state                                      string
		evaluated, failures                            int
		acted, first, firstActed, repeats, repeatActed int
	}
	var gates []gate
	for rows.Next() {
		var g gate
		if err = rows.Scan(&g.id, &g.evaluated, &g.failures, &g.state, &g.acted, &g.first, &g.firstActed, &g.repeats, &g.repeatActed); err != nil {
			break
		}
		gates = append(gates, g)
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	var notices []string
	for _, g := range gates {
		// Each evaluation uses a new batch, so two failures cannot be the same data.
		stats, err := c.QueryContext(ctx, `SELECT action,repeated,sum(settled),sum(acted) FROM surface_stats WHERE project_id=? AND surface=? GROUP BY action,repeated`, project, g.id)
		if err != nil {
			return notices, err
		}
		total, acted, first, fa, repeats, ra := 0, 0, 0, 0, 0, 0
		controls := map[string]SurfaceCount{}
		for stats.Next() {
			var a string
			var repeat, n, yes int
			if err = stats.Scan(&a, &repeat, &n, &yes); err != nil {
				break
			}
			if a == "given" || a == "replaced" {
				total += n
				acted += yes
				if repeat == 0 {
					first += n
					fa += yes
				} else {
					repeats += n
					ra += yes
				}
			} else {
				v := controls[a]
				v.Settled += n
				v.Acted += yes
				controls[a] = v
			}
		}
		if err = errors.Join(err, stats.Err(), stats.Close()); err != nil {
			return notices, err
		}
		if total-g.evaluated < 30 {
			continue
		}
		base := SurfaceCount{}
		for _, kind := range []string{"shadow", "held-back", "control"} {
			if controls[kind].Settled > 0 {
				base = controls[kind]
				break
			}
		}
		// First firings may all precede this batch in one long session. Compare
		// cumulative first/repeat populations, while the efficacy interval uses
		// only fresh firings so an old failure cannot be counted twice.
		state, reason := GateDecision(total-g.evaluated, acted-g.acted, first, fa, repeats, ra, base.Settled, base.Acted, OncePerSession(g.id))
		if state == "collecting" {
			continue
		}
		failures := 0
		if state == "fail" {
			failures = g.failures + 1
		}
		if failures >= 2 {
			state = "off"
		}
		if _, err = c.ExecContext(ctx, `UPDATE surface_gates SET evaluated=?,evaluated_acted=?,evaluated_first=?,evaluated_first_acted=?,evaluated_repeat=?,evaluated_repeat_acted=?,failures=?,state=?,reason=? WHERE project_id=? AND surface=?`, total, acted, first, fa, repeats, ra, failures, state, reason, project, g.id); err != nil {
			return notices, err
		}
	}
	return notices, nil
}

func claimSurfaceNotices(ctx context.Context, c *sql.Conn, project string) ([]string, error) {
	rows, err := c.QueryContext(ctx, `UPDATE surface_gates SET announced=1 WHERE project_id=? AND state='off' AND announced=0 RETURNING surface`, project)
	if err != nil {
		return nil, err
	}
	var notices []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		notices = append(notices, fmt.Sprintf("MEX: %s turned off after two failed efficacy checks.", id))
	}
	return notices, errors.Join(err, rows.Err(), rows.Close())
}
