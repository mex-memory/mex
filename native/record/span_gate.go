package record

import (
	"context"
	"database/sql"
)

type KeepRule struct {
	AvoidedDelta             float64
	CostSessions, NoHarmRise int
}

func SurfaceKeepRule(surface string) KeepRule {
	if surface == "search-span" {
		return KeepRule{.30, 10, 1}
	}
	return KeepRule{}
}

// The task-cost ledger supplies qualification projections after it has priced
// carried output, avoided calls and induced calls. Hook coincidence data alone
// cannot authorize promotion, and offline replay cannot populate these checks.
func additionalSurfaceGate(ctx context.Context, c *sql.Conn, project, surface, baseKind string, total, acted, baseTotal, baseActed int) (string, string, error) {
	var rule KeepRule
	err := c.QueryRowContext(ctx, `SELECT minimum_avoided_delta,minimum_cost_sessions,no_harm_rise FROM surface_gates WHERE project_id=? AND surface=?`, project, surface).Scan(&rule.AvoidedDelta, &rule.CostSessions, &rule.NoHarmRise)
	if err != nil {
		return "", "", err
	}
	if rule.AvoidedDelta == 0 && rule.CostSessions == 0 && rule.NoHarmRise == 0 {
		return "pass", "acted and repeat gates passed", nil
	}
	if total == 0 || baseTotal == 0 {
		return "collecting", "missing avoidance controls", nil
	}
	if float64(acted)/float64(total)-float64(baseActed)/float64(baseTotal)+1e-12 < rule.AvoidedDelta {
		return "fail", "avoided reads improve by less than 30 points", nil
	}
	if rule.NoHarmRise != 0 {
		var liveN, liveHarm, baseN, baseHarm int
		err = c.QueryRowContext(ctx, `SELECT coalesce(sum(CASE WHEN f.action='given' THEN 1 ELSE 0 END),0),coalesce(sum(CASE WHEN f.action='given' THEN w.harm ELSE 0 END),0),coalesce(sum(CASE WHEN f.action=? THEN 1 ELSE 0 END),0),coalesce(sum(CASE WHEN f.action=? THEN w.harm ELSE 0 END),0) FROM surface_windows w JOIN surface_firings f ON f.id=w.firing_id WHERE f.project_id=? AND f.surface=? AND w.settled=1 AND w.observed>0`, baseKind, baseKind, project, surface).Scan(&liveN, &liveHarm, &baseN, &baseHarm)
		if err != nil {
			return "", "", err
		}
		if liveN == 0 || baseN == 0 {
			return "collecting", "missing same-file harm controls", nil
		}
		if float64(liveHarm)/float64(liveN) > float64(baseHarm)/float64(baseN) {
			return "fail", "reads elsewhere in the same file rose", nil
		}
	}
	var sessions int
	var net float64
	err = c.QueryRowContext(ctx, `SELECT count(DISTINCT session_id),coalesce(sum(net_weighted_tokens),0) FROM surface_cost_checks WHERE project_id=? AND surface=?`, project, surface).Scan(&sessions, &net)
	if err != nil {
		return "", "", err
	}
	if sessions < rule.CostSessions {
		return "collecting", "need priced task-cost evidence over ten sessions", nil
	}
	if net <= 0 {
		return "fail", "net task-cost saving is not positive", nil
	}
	return "pass", "avoided reads, same-file harm and task-cost gates passed", nil
}
