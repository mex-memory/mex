package record

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	LeverCompaction = "compaction"
	LeverOutline    = "outline"
	LeverShellTrim  = "shell-trim"
	LeverWrapper    = "codex-wrapper"
)

type LeverObservation struct {
	Lever         string `json:"lever"`
	Kind          string `json:"kind"`
	TokensRemoved int    `json:"tokens_removed"`
	TokensAdded   int    `json:"tokens_added,omitempty"`
	HookMS        int64  `json:"hook_ms"`
}

// LedgerTerm covers savings with the same carry length. The unsuffixed lever
// holds the first term and the session's costs. Further terms use lever#turns.
// Raw savings are stored per turn. Priced savings include every carried turn.
type LedgerTerm struct {
	Lever                 string `json:"lever"`
	TokensRemoved         int64  `json:"tokens_removed"`
	TurnsCarried          int64  `json:"turns_carried"`
	CostTokens            int64  `json:"cost_tokens"`
	Refetches             int64  `json:"refetches"`
	SavedInputMillitokens int64  `json:"saved_input_millitokens"`
	CostInputMillitokens  int64  `json:"cost_input_millitokens"`
}

const MaxLedgerTerms = 4096
const maxPricedTotal = 1 << 49

func leverForHost(lever, host string) bool {
	switch lever {
	case LeverCompaction:
		return host == "claude-code" || host == "codex"
	case LeverOutline, LeverShellTrim:
		return host == "claude-code"
	case LeverWrapper:
		return host == "codex"
	}
	return false
}

// RecordLeverObservation adds a numeric control receipt to the active main
// epoch. Callers record after output is written. No payload text is retained.
func (hooks *Hooks) RecordLeverObservation(session Session, key string, at time.Time, o LeverObservation) error {
	if hooks.counterOnly || !leverForHost(o.Lever, session.Agent) || o.Lever == LeverCompaction ||
		(o.Kind != "saving" && o.Kind != "refetch" && o.Kind != "denial") ||
		o.TokensRemoved < 0 || o.TokensRemoved > 8<<20 || o.TokensAdded < 0 || o.TokensAdded > 8<<20 ||
		o.HookMS < 0 || o.HookMS > 60_000 {
		return errors.New("invalid lever observation")
	}
	detail, err := json.Marshal(o)
	if err != nil {
		return err
	}
	stamp := at.UTC().Format(time.RFC3339Nano)
	id := shortHash("lever\x00" + session.Agent + "\x00" + session.SessionID + "\x00" + session.Checkout + "\x00" + o.Lever + "\x00" + o.Kind + "\x00" + key)
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	return hooks.write(ctx, `
		INSERT OR IGNORE INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,project_id,checkout,detail)
		SELECT ?,s.session_id,'',e.epoch,?,'lever-observation',?,'one-line',0,'control',s.project_id,s.checkout,?
		FROM sessions s JOIN epochs e USING(session_id)
		WHERE s.session_id=? AND s.agent=? AND s.project_id=? AND s.checkout=? AND s.paused=0 AND e.agent_id=''
		ORDER BY e.epoch DESC LIMIT 1`,
		id, stamp, "mex:lever:"+o.Lever, string(detail), session.SessionID, session.Agent, session.ProjectID, session.Checkout)
}

func validateLedgerTerms(agent string, terms []LedgerTerm) error {
	if len(terms) > MaxLedgerTerms {
		return errors.New("too many ledger terms")
	}
	keys := map[string]bool{}
	pricedTotals := map[string]int64{}
	for _, t := range terms {
		lever, count, extra := strings.Cut(t.Lever, "#")
		if !leverForHost(lever, agent) || keys[t.Lever] || t.TokensRemoved < 0 || t.TokensRemoved > 1<<34 ||
			t.TurnsCarried < 0 || t.TurnsCarried > 32_000 || t.CostTokens < 0 || t.CostTokens > 1<<38 ||
			t.Refetches < 0 || t.Refetches > 32_000 ||
			t.SavedInputMillitokens < 0 || t.SavedInputMillitokens > maxPricedTotal ||
			t.CostInputMillitokens < 0 || t.CostInputMillitokens > maxPricedTotal {
			return errors.New("invalid ledger term")
		}
		if extra && (count != strconv.FormatInt(t.TurnsCarried, 10) || t.CostTokens != 0 || t.CostInputMillitokens != 0 || t.Refetches != 0) {
			return errors.New("invalid supplemental ledger term")
		}
		pricedTotals[lever] += t.SavedInputMillitokens + t.CostInputMillitokens
		if pricedTotals[lever] > maxPricedTotal {
			return errors.New("priced ledger total exceeds supported range")
		}
		keys[t.Lever] = true
	}
	for _, t := range terms {
		if lever, _, extra := strings.Cut(t.Lever, "#"); extra && !keys[lever] {
			return errors.New("missing main ledger term")
		}
	}
	return nil
}

// SettleLedger replaces one finished session's main-actor terms atomically.
// Rows for other actors and unrelated ledger keys are outside this writer.
func (hooks *Hooks) SettleLedger(session Session, ended time.Time, profile string, terms []LedgerTerm) (bool, error) {
	if hooks.counterOnly || !leverForHost(LeverCompaction, session.Agent) || ended.IsZero() {
		return false, errors.New("invalid ledger session")
	}
	if len(profile) == 0 || len(profile) > 64 || strings.ContainsFunc(profile, func(r rune) bool {
		return r != '-' && (r < 'a' || r > 'z') && (r < '0' || r > '9')
	}) {
		return false, errors.New("invalid ledger price profile")
	}
	if err := validateLedgerTerms(session.Agent, terms); err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if err := hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return false, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	var started, seen string
	var previous, previousProfile sql.NullString
	err = conn.QueryRowContext(ctx, `SELECT s.started_at,s.last_seen_at,l.ended_at,l.price_profile
		FROM sessions s LEFT JOIN ledger_settlements l USING(session_id)
		WHERE s.session_id=? AND s.agent=? AND s.project_id=? AND s.checkout=? AND s.paused=0`,
		session.SessionID, session.Agent, session.ProjectID, session.Checkout).Scan(&started, &seen, &previous, &previousProfile)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	for _, clock := range []string{started, seen} {
		if at, err := time.Parse(time.RFC3339Nano, clock); err != nil || at.After(ended) {
			return false, nil
		}
	}
	if previous.Valid {
		last, err := time.Parse(time.RFC3339Nano, previous.String)
		if err != nil || last.After(ended) {
			return false, nil
		}
		// A retried claim may see a file change after the original settlement.
		if last.Equal(ended) && previousProfile.String == profile {
			return true, nil
		}
	}
	_, err = conn.ExecContext(ctx, `DELETE FROM ledger WHERE session_id=? AND agent_id=''
		AND (lever IN ('compaction','outline','shell-trim','codex-wrapper')
			OR lever GLOB 'compaction#*' OR lever GLOB 'outline#*' OR lever GLOB 'shell-trim#*' OR lever GLOB 'codex-wrapper#*')`,
		session.SessionID)
	if err != nil {
		return false, err
	}
	if len(terms) > 0 {
		insert, err := conn.PrepareContext(ctx, `INSERT INTO ledger(session_id,agent_id,lever,tokens_removed,turns_carried,cost_tokens,refetches,
			saved_input_millitokens,cost_input_millitokens) VALUES(?,'',?,?,?,?,?,?,?)`)
		if err != nil {
			return false, err
		}
		defer insert.Close()
		for _, t := range terms {
			if _, err := insert.ExecContext(ctx, session.SessionID, t.Lever, t.TokensRemoved, t.TurnsCarried, t.CostTokens, t.Refetches,
				t.SavedInputMillitokens, t.CostInputMillitokens); err != nil {
				return false, err
			}
		}
	}
	_, err = conn.ExecContext(ctx, `INSERT INTO ledger_settlements(session_id,ended_at,price_profile) VALUES(?,?,?)
		ON CONFLICT(session_id) DO UPDATE SET ended_at=excluded.ended_at,price_profile=excluded.price_profile`,
		session.SessionID, ended.UTC().Format(time.RFC3339Nano), profile)
	if err != nil {
		return false, err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return false, fmt.Errorf("settle ledger: %w", err)
	}
	return true, nil
}
