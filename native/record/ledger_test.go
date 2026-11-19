package record

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestLedgerMigrationsUpgradeHooksV10(t *testing.T) {
	location := testLocation(t)
	db, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	const upstreamVersion = 10
	var steps []migration
	for i, name := range hookMigrationFiles[:upstreamVersion] {
		data, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, migration{i + 1, string(data)})
	}
	if err := migrate(ctx, db, steps); err != nil {
		t.Fatal(err)
	}
	if version, err := schemaVersion(ctx, db); err != nil || version != upstreamVersion {
		t.Fatalf("fixture schema %d: %v", version, err)
	}
	const stamp = "2026-11-17T13:00:00Z"
	if _, err := db.Exec(`
		INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at)
		VALUES('s','claude-code','f-fixture','/fixture',?,?);
		INSERT INTO epochs(session_id,epoch,started_at,false_send_counted) VALUES('s',0,?,1);
		INSERT INTO surface_cost_checks VALUES('f-fixture','search-span','s','',42.5);
		INSERT INTO lane_offers VALUES('s','',0,'f-fixture','/fixture','card','anchor',250,1);
		INSERT INTO ledger(session_id,lever,tokens_removed) VALUES('s','outline',100);`, stamp, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	hooks, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if version, err := schemaVersion(ctx, hooks.db); err != nil || version != SchemaVersion {
		t.Fatalf("upgraded schema %d: %v", version, err)
	}
	var counted, held, raw int
	var net float64
	var saved, cost sql.NullInt64
	var profile sql.NullString
	err = hooks.db.QueryRow(`SELECT e.false_send_counted,o.budget_held,c.net_weighted_tokens,
		l.tokens_removed,l.saved_input_millitokens,l.cost_input_millitokens,p.price_profile
		FROM epochs e JOIN lane_offers o USING(session_id,agent_id,epoch)
		JOIN surface_cost_checks c USING(session_id,agent_id)
		JOIN ledger l USING(session_id,agent_id)
		LEFT JOIN ledger_settlements p USING(session_id) WHERE e.session_id='s'`).
		Scan(&counted, &held, &net, &raw, &saved, &cost, &profile)
	if err != nil || counted != 1 || held != 1 || net != 42.5 || raw != 100 || saved.Valid || cost.Valid || profile.Valid {
		t.Fatalf("upgraded values %d %d %g %d %+v %+v %+v: %v", counted, held, net, raw, saved, cost, profile, err)
	}
}

func TestSettleLedgerKeepsSeparateEndAndHookClocks(t *testing.T) {
	hooks, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	start := time.Date(2026, 11, 17, 13, 0, 0, 0, time.UTC)
	activity, end := start.Add(time.Minute), start.Add(2*time.Minute)
	session := Session{SessionID: "s", Agent: "claude-code", ProjectID: "f-fixture", Checkout: "/fixture",
		StartedAt: start.Format(time.RFC3339Nano), LastSeenAt: activity.Format(time.RFC3339Nano)}
	if err := hooks.PutSession(session); err != nil {
		t.Fatal(err)
	}
	// A pending retry from the previous schema can replace its raw terms at
	// the same end, while a retry of the same priced settlement is idempotent.
	if _, err := hooks.db.Exec(`INSERT INTO ledger_settlements(session_id,ended_at) VALUES('s',?)`, end.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if _, err := hooks.db.Exec("INSERT INTO ledger(session_id,lever,tokens_removed) VALUES('s','compaction',100)"); err != nil {
		t.Fatal(err)
	}
	const profile = "saved-session-reference-2026-11-16"
	terms := []LedgerTerm{{Lever: LeverCompaction, TokensRemoved: 70, TurnsCarried: 3, CostTokens: 210,
		SavedInputMillitokens: 21_000, CostInputMillitokens: 210_000}}
	if saved, err := hooks.SettleLedger(session, end, profile, terms, nil, ""); err != nil || !saved {
		t.Fatal(saved, err)
	}
	// A stale end or a retry with newly measured terms keeps the first
	// settlement for this end. A newer genuine end can replace it.
	if saved, err := hooks.SettleLedger(session, end.Add(-time.Second), profile, nil, nil, ""); err != nil || saved {
		t.Fatal(saved, err)
	}
	if saved, err := hooks.SettleLedger(session, end, profile, nil, nil, ""); err != nil || !saved {
		t.Fatal(saved, err)
	}
	var seen, ended, pricedWith string
	var removed, saved, cost int64
	err = hooks.db.QueryRow(`SELECT last_seen_at,ended_at,tokens_removed,price_profile,saved_input_millitokens,cost_input_millitokens
		FROM sessions JOIN ledger_settlements USING(session_id) JOIN ledger USING(session_id) WHERE session_id='s'`).
		Scan(&seen, &ended, &removed, &pricedWith, &saved, &cost)
	if err != nil || seen != session.LastSeenAt || ended != end.Format(time.RFC3339Nano) || removed != 70 ||
		pricedWith != profile || saved != 21_000 || cost != 210_000 {
		t.Fatal(seen, ended, removed, pricedWith, saved, cost, err)
	}
	terms[0].TokensRemoved = 55
	if saved, err := hooks.SettleLedger(session, end.Add(time.Minute), profile, terms, nil, ""); err != nil || !saved {
		t.Fatal(saved, err)
	}
	if err := hooks.db.QueryRow(`SELECT tokens_removed FROM ledger WHERE session_id='s'`).Scan(&removed); err != nil || removed != 55 {
		t.Fatal(removed, err)
	}
}

func TestLedgerSessionMetricsUpgradeAndRetry(t *testing.T) {
	location := testLocation(t)
	db, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var steps []migration
	for i, name := range hookMigrationFiles[:12] {
		data, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, migration{i + 1, string(data)})
	}
	if err := migrate(ctx, db, steps); err != nil {
		t.Fatal(err)
	}
	const stamp = "2026-11-17T13:00:00Z"
	const profile = "saved-session-reference-2026-11-16"
	if _, err := db.Exec("INSERT INTO sessions VALUES('old','claude-code','f-fixture','/fixture',?,?,0)", stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO ledger_settlements VALUES('old',?,?)", stamp, profile); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO ledger(session_id,lever,saved_input_millitokens,cost_input_millitokens) VALUES('old','outline',900,150)"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	hooks, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()

	old := Session{SessionID: "old", Agent: "claude-code", ProjectID: "f-fixture", Checkout: "/fixture", StartedAt: stamp, LastSeenAt: stamp}
	const trial = "0123456789abcdef0123456789abcdef"
	if held, err := hooks.EnrollLedgerTrial(old, trial, true); err != nil || held {
		t.Fatal("existing session enrolled", held, err)
	}
	end, _ := time.Parse(time.RFC3339Nano, stamp)
	metrics := LedgerSessionMetrics{Model: "claude-sonnet-5-5", Requests: 2, EndInputTokens: 1000, SpendInputMillitokens: 50_000}
	if saved, err := hooks.SettleLedger(old, end, profile, nil, &metrics, trial); err != nil || !saved {
		t.Fatal(saved, err)
	}
	var net, spend int64
	var assigned sql.NullInt64
	err = hooks.db.QueryRow(`SELECT saved_input_millitokens-cost_input_millitokens,spend_input_millitokens,holdout
		FROM ledger l JOIN ledger_session_metrics m USING(session_id) WHERE l.session_id='old'`).Scan(&net, &spend, &assigned)
	if err != nil || net != 750 || spend != 50_000 || assigned.Valid {
		t.Fatal(net, spend, assigned, err)
	}

	control := old
	control.SessionID = "control"
	if held, err := hooks.EnrollLedgerTrial(control, trial, true); err != nil || !held {
		t.Fatal(held, err)
	}
	if held, err := ReadLedgerHoldout(location.Hooks, control.SessionID, control.Agent, trial); err != nil || !held {
		t.Fatal(held, err)
	}
	if saved, err := hooks.SettleLedger(control, end, profile, nil, &metrics, trial); err != nil || !saved {
		t.Fatal(saved, err)
	}
	metrics.SpendInputMillitokens *= 2
	if saved, err := hooks.SettleLedger(control, end, profile, nil, &metrics, trial); err != nil || !saved {
		t.Fatal(saved, err)
	}
	var footprint int
	err = hooks.db.QueryRow(`SELECT spend_input_millitokens,holdout,mex_context_tokens
		FROM ledger_session_metrics WHERE session_id='control'`).Scan(&spend, &assigned, &footprint)
	if err != nil || spend != 50_000 || !assigned.Valid || assigned.Int64 != 1 || footprint != 0 {
		t.Fatal(spend, assigned, footprint, err)
	}
	if saved, err := hooks.SettleLedger(control, end.Add(time.Second), profile, nil, &metrics, ""); err != nil || !saved {
		t.Fatal(saved, err)
	}
	var rows int
	if err := hooks.db.QueryRow("SELECT count(*) FROM ledger_session_metrics WHERE session_id='control'").Scan(&rows); err != nil || rows != 0 {
		t.Fatal("control after opt-out entered the ordinary sample", rows, err)
	}
}
