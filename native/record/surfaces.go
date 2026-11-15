package record

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/internal/safefile"
	pathscope "github.com/mex-memory/mex/native/internal/scope"
	"github.com/mex-memory/mex/native/record/place"
)

// SurfaceIDs is the closed vocabulary used by receipts, controls and reports.
// New ids must declare a default and an acted definition before they can send.
func SurfaceIDs() []string {
	return []string{"read-pitfall", "read-risk", "edit", "command-recipe", "failure-fix", "prompt", "start-brief", "recovery", "rescue-wrong-path", "rescue-search", "rescue-wide", "rescue-glob-timeout", "bug-history", "start-brief-previous", "graph-card", "unknown"}
}
func ValidSurface(s string) bool {
	for _, id := range SurfaceIDs() {
		if s == id {
			return true
		}
	}
	return false
}

// SurfaceDefault: surfaces that sent before the ledger existed stay on. New ones
// start in trial: shadow until the base rate is measured, then a randomized
// share of sessions, until the gate turns them on or off.
func SurfaceDefault(s string) string {
	switch s {
	case "read-pitfall", "read-risk", "edit", "command-recipe", "failure-fix", "prompt", "start-brief", "recovery":
		return "on"
	case "unknown", "start-brief-previous":
		return "shadow"
	}
	return "trial"
}

// ValidSurfaceMode lists the per-project states a setting may name.
func ValidSurfaceMode(m string) bool { return m == "on" || m == "shadow" || m == "trial" || m == "off" }

// OncePerSession surfaces fire at most once per session by construction, so
// the gate's repeat comparison can never collect evidence for them.
func OncePerSession(s string) bool { return s == "start-brief" || s == "start-brief-previous" }

// Trial needs this many settled shadow firings before any session sends, so
// the arm that sends is always compared with a measured base rate.
const TrialBaseFirings = 30

// trialMode resolves a trial surface for one session. Before the base rate is
// measured every firing is shadow. Afterwards each session is assigned to the
// sending or the shadow arm by a stable hash of session and surface, so one
// session never mixes arms and the shadow arm keeps measuring the base rate.
// A passed gate turns the surface on.
func trialMode(ctx context.Context, c *sql.Conn, req DeliveryRequest, surface, gate string) (string, error) {
	if gate == "pass" {
		return "on", nil
	}
	var base int
	if err := c.QueryRowContext(ctx, `SELECT coalesce(sum(settled),0) FROM surface_stats WHERE project_id=? AND surface=? AND action='shadow'`, req.Session.ProjectID, surface).Scan(&base); err != nil {
		return "", err
	}
	if base < TrialBaseFirings {
		return "shadow", nil
	}
	return TrialArm(req.Session.SessionID, req.AgentID, surface), nil
}

// TrialArm is the session's arm: half the sessions send, half stay shadow.
func TrialArm(session, agent, surface string) string {
	sum := sha256.Sum256([]byte("mex-trial\x00" + session + "\x00" + agent + "\x00" + surface))
	if sum[0]&1 == 0 {
		return "on"
	}
	return "shadow"
}
func SurfaceForMoment(s string) string {
	switch s {
	case "read":
		return "read-pitfall"
	case "read-risk":
		return "read-risk"
	case "edit", "rejected", "create":
		return "edit"
	case "command":
		return "command-recipe"
	case "failure":
		return "failure-fix"
	case "prompt":
		return "prompt"
	case "start-brief":
		return "start-brief"
	case "recovery", "resume", "subagent", "brief", "correction", "companion":
		return "recovery"
	}
	return "unknown"
}

// Targets are immutable receipt evidence, bounded at admission. Commands are
// exact-command digests, never command text. No event text is persisted.
type SurfaceTarget struct {
	Scopes   []string `json:"scopes,omitempty"`
	Paths    []string `json:"paths,omitempty"`
	Names    []string `json:"names,omitempty"`
	Commands []string `json:"commands,omitempty"`
	Failure  string   `json:"failure,omitempty"`
	Anti     []string `json:"anti,omitempty"`
}
type SurfaceTool struct {
	Scoped              map[string]SurfaceTool // one shallow observation per checkout; one original call
	Paths               []string
	Names               []string
	Command             string
	Added               string
	Edit, Open, Success bool
}

// Acted is deliberately positive evidence. Unknown outcomes and missing edit
// text never prove avoidance. Paths must already be checkout-relative.
func Acted(surface string, target SurfaceTarget, tool SurfaceTool) bool {
	command := func() bool {
		for _, c := range target.Commands {
			if c != "" && c == tool.Command {
				return true
			}
		}
		return false
	}
	if surface == "command-recipe" {
		return command()
	}
	if surface == "failure-fix" {
		return command() || (tool.Success && target.Failure != "" && target.Failure == tool.Command)
	}
	if !tool.Success {
		return false
	}
	namedTouch := func() bool {
		for _, p := range tool.Paths {
			for _, named := range target.Paths {
				if p == named {
					return true
				}
			}
		}
		return false
	}
	scopeTouch := func() bool {
		for _, p := range tool.Paths {
			for _, scope := range target.Scopes {
				if pathscope.MatchesScope(scope, p) {
					return true
				}
			}
		}
		return false
	}
	touch := func() bool { return namedTouch() || scopeTouch() }
	switch surface {
	case "read-pitfall", "read-risk", "edit":
		if !tool.Edit || !touch() {
			return false
		}
		if namedTouch() {
			return true
		}
		if len(target.Anti) == 0 || tool.Added == "" {
			return false
		}
		for _, literal := range target.Anti {
			if strings.Contains(tool.Added, literal) {
				return false
			}
		}
		return true
	case "prompt", "start-brief", "start-brief-previous", "recovery":
		return (tool.Open || tool.Edit) && scopeTouch()
	case "bug-history":
		return (tool.Open || tool.Edit) && touch()
	case "rescue-wrong-path", "rescue-search", "rescue-wide", "rescue-glob-timeout":
		if namedTouch() {
			return true
		}
		for _, n := range tool.Names {
			for _, name := range target.Names {
				if n == name {
					return true
				}
			}
		}
	}
	return false
}

func surfaceTargetJSON(t SurfaceTarget) (string, error) {
	if len(t.Scopes) > 32 || len(t.Paths) > 32 || len(t.Names) > 4 || len(t.Commands) > 32 || len(t.Anti) > 32 {
		return "", errors.New("surface target bound")
	}
	for _, values := range [][]string{t.Scopes, t.Paths, t.Names, t.Commands, t.Anti, {t.Failure}} {
		for _, value := range values {
			if len(value) > 4096 || strings.ContainsRune(value, 0) {
				return "", errors.New("surface target field bound")
			}
		}
	}
	b, err := json.Marshal(t)
	if err != nil || len(b) > 8192 || strings.ContainsRune(string(b), 0) {
		return "", errors.New("surface target bound")
	}
	return string(b), nil
}

func addSurfaceWindow(ctx context.Context, c *sql.Conn, req DeliveryRequest, e Epoch, r Receipt) error {
	if r.Correction || r.EntryID == "mex:start-brief" || (r.Action != "given" && r.Action != "replaced" && r.Action != "shadow" && r.Action != "held-back" && r.Action != "control") {
		return nil
	}
	if len(r.Target.Scopes)+len(r.Target.Paths)+len(r.Target.Names)+len(r.Target.Commands) == 0 && r.Target.Failure == "" {
		return nil
	}
	var full bool
	if err := c.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM surface_windows WHERE session_id=? AND agent_id=? AND settled=0 LIMIT 1 OFFSET 999)`, req.Session.SessionID, req.AgentID).Scan(&full); err != nil {
		return err
	}
	if full {
		return errors.New("surface pending bound")
	}
	target, err := surfaceTargetJSON(r.Target)
	if err != nil {
		return err
	}
	var repeated int
	if r.Action == "given" || r.Action == "replaced" || r.Action == "shadow" {
		if _, err = c.ExecContext(ctx, `INSERT OR IGNORE INTO surface_session_first VALUES(?,?,?,?,?,?)`, req.Session.SessionID, req.AgentID, req.Session.ProjectID, req.Session.Checkout, r.Surface, r.BlockID); err != nil {
			return err
		}
	}
	err = c.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM surface_session_first WHERE session_id=? AND agent_id=? AND project_id=? AND checkout=? AND surface=? AND block_id<>?)`, req.Session.SessionID, req.AgentID, req.Session.ProjectID, req.Session.Checkout, r.Surface, r.BlockID).Scan(&repeated)
	if err != nil {
		return err
	}
	action := r.Action
	if action == "replaced" {
		action = "given"
	}
	firing := r.BlockID + ":" + r.Surface + ":" + action
	claim, err := c.ExecContext(ctx, `INSERT OR IGNORE INTO surface_firings(id,session_id,agent_id,epoch,project_id,checkout,surface,action,repeated) VALUES(?,?,?,?,?,?,?,?,?)`, firing, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, r.Surface, action, repeated)
	if err != nil {
		return err
	}
	newFiring, err := claim.RowsAffected()
	if err != nil {
		return err
	}
	if _, err = c.ExecContext(ctx, `UPDATE surface_firings SET pending=pending+1,tokens=tokens+? WHERE id=?`, r.Tokens, firing); err != nil {
		return err
	}
	_, err = c.ExecContext(ctx, `INSERT INTO surface_windows(delivery_id,session_id,agent_id,epoch,project_id,checkout,expires,target,repeated,firing_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, r.ID, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, e.ToolCalls+40, target, repeated, firing)
	if err != nil {
		return err
	}
	_, err = c.ExecContext(ctx, `INSERT INTO surface_stats(project_id,checkout,surface,action,repeated,firings,tokens,receipts) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(project_id,checkout,surface,action,repeated) DO UPDATE SET firings=firings+excluded.firings,tokens=tokens+excluded.tokens,receipts=receipts+1`, req.Session.ProjectID, req.Session.Checkout, r.Surface, action, repeated, newFiring, r.Tokens)
	if err == nil && newFiring > 0 {
		kind := "control"
		if r.Action == "given" || r.Action == "replaced" {
			kind = "live"
		}
		if r.Action == "shadow" {
			kind = "shadow"
		}
		err = surfaceCounter(ctx, c, req, kind)
	}
	return err
}

func surfaceCounter(ctx context.Context, c *sql.Conn, req DeliveryRequest, kind string) error {
	if req.Session.Agent != "claude-code" && req.Session.Agent != "codex" {
		return nil
	}
	_, err := c.ExecContext(ctx, `INSERT INTO counters_go(day,name,value) VALUES(?,?,1) ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+1)`, req.Now.UTC().Format("2006-01-02"), "agent:"+req.Session.Agent+":surfaces."+kind)
	return err
}

func surfacePendingPath(directory, session, agent string) string {
	return filepath.Join(directory, "surface-pending", place.ShortHash(session+"\x00"+agent))
}

func SurfaceOff(directory, project, surface string) bool {
	if !ValidSurface(surface) || project == "" || strings.ContainsAny(project, "/\\:\x00") || project == "." || project == ".." {
		return false
	}
	info, err := os.Lstat(filepath.Join(directory, "surface-off", project, surface))
	return err == nil && info.Mode().IsRegular()
}

// Publish only committed, irreversible off transitions. Missing markers merely
// cost an extra SQLite check; they cannot authorize a send past the gate.
func (h *Hooks) publishSurfaceOff(project string, ids []string) {
	if project == "" || strings.ContainsAny(project, "/\\:\x00") || project == "." || project == ".." {
		return
	}
	root, err := os.OpenRoot(h.directory)
	if err != nil {
		return
	}
	defer root.Close()
	for _, dir := range []string{"surface-off", filepath.Join("surface-off", project)} {
		if err = root.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return
		}
		info, err := root.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return
		}
	}
	for _, id := range ids {
		if !ValidSurface(id) {
			continue
		}
		f, err := root.OpenFile(filepath.Join("surface-off", project, id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err == nil {
			_ = f.Close()
		}
	}
}

// This is only an existence hint. Counters, targets and claims live in SQLite.
func SurfacePending(directory, session, agent string) bool {
	info, err := os.Lstat(surfacePendingPath(directory, session, agent))
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}
func (h *Hooks) syncSurfacePending(ctx context.Context, c *sql.Conn, req DeliveryRequest) (func(bool), error) {
	noop := func(bool) {}
	var pending bool
	if err := c.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM surface_windows WHERE session_id=? AND agent_id=? AND settled=0)`, req.Session.SessionID, req.AgentID).Scan(&pending); err != nil {
		return noop, err
	}
	p := surfacePendingPath(h.directory, req.Session.SessionID, req.AgentID)
	if !pending {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			return noop, nil
		}
	}
	root, err := os.OpenRoot(h.directory)
	if err != nil {
		return noop, err
	}
	dir := filepath.Join("surface-pending", place.ShortHash(req.Session.SessionID+"\x00"+req.AgentID))
	if err = root.Mkdir("surface-pending", 0700); err != nil && !os.IsExist(err) {
		root.Close()
		return noop, err
	}
	parent, err := root.Lstat("surface-pending")
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
		root.Close()
		return noop, errors.New("redirected surface hints")
	}
	if err = root.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		root.Close()
		return noop, err
	}
	info, err := root.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		root.Close()
		return noop, errors.New("redirected surface hint")
	}
	active := filepath.Join(dir, "active")
	create := func(name string) error {
		if !safefile.Regular(filepath.Join(h.directory, name)) {
			return errors.New("redirected surface hint")
		}
		f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if os.IsExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return f.Close()
	}
	guard := ""
	if pending {
		err = create(active)
	} else {
		id, idErr := receiptID()
		if idErr != nil {
			root.Close()
			return noop, idErr
		}
		guard = filepath.Join(dir, "retiring-"+id)
		err = create(guard)
		if err == nil {
			err = root.Remove(active)
			if os.IsNotExist(err) {
				err = nil
			}
		}
	}
	if err != nil {
		root.Close()
		return noop, err
	}
	// Old guards imply an earlier transaction has released the SQLite lock.
	// Keep our own guard until COMMIT; a crash can cause only an extra DB read.
	d, err := root.Open(dir)
	if err != nil {
		root.Close()
		return noop, err
	}
	children, _ := d.ReadDir(64)
	d.Close()
	for _, child := range children {
		name := filepath.Join(dir, child.Name())
		if name != guard && strings.HasPrefix(child.Name(), "retiring-") && child.Type().IsRegular() {
			_ = root.Remove(name)
		}
	}
	return func(committed bool) {
		defer root.Close()
		if guard == "" {
			return
		}
		if !committed {
			_ = create(active)
		}
		_ = root.Remove(guard)
		if committed {
			_ = root.Remove(dir)
		} // non-recursive; an active writer keeps it nonempty
	}, nil
}

func settleSurfaceWindows(ctx context.Context, c *sql.Conn, req DeliveryRequest, e *Epoch, close bool) error {
	// The pending index bounds work to this agent's current 40-call window.
	rows, err := c.QueryContext(ctx, `SELECT w.delivery_id,f.surface,f.action,w.target,w.repeated,w.acted,w.expires,w.project_id,w.checkout,w.firing_id FROM surface_windows w JOIN surface_firings f ON f.id=w.firing_id WHERE w.session_id=? AND w.agent_id=? AND w.epoch=? AND w.settled=0 ORDER BY w.expires LIMIT 1001`, req.Session.SessionID, req.AgentID, e.Number)
	if err != nil {
		return err
	}
	type pending struct {
		id, surface, action, target, project, checkout, firing string
		repeat, acted, expires                                 int
	}
	var pendingRows []pending
	for rows.Next() {
		var p pending
		err = rows.Scan(&p.id, &p.surface, &p.action, &p.target, &p.repeat, &p.acted, &p.expires, &p.project, &p.checkout, &p.firing)
		if err != nil {
			break
		}
		pendingRows = append(pendingRows, p)
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return err
	}
	if len(pendingRows) > 1000 {
		return errors.New("surface pending bound")
	}
	for _, p := range pendingRows {
		if err := ctx.Err(); err != nil {
			return err
		}
		acted := p.acted
		decided := false
		var target SurfaceTarget
		if json.Unmarshal([]byte(p.target), &target) != nil {
			return errors.New("invalid surface target")
		}
		for offset, tool := range req.SurfaceTools {
			if err := ctx.Err(); err != nil {
				return err
			}
			if e.ToolCalls+offset >= p.expires {
				break
			}
			matches := p.project == req.Session.ProjectID && p.checkout == req.Session.Checkout
			if len(tool.Scoped) > 0 {
				var ok bool
				tool, ok = tool.Scoped[p.project+"\n"+p.checkout]
				matches = ok
			}
			if !matches {
				continue
			}
			if Acted(p.surface, target, tool) {
				acted = 1
			}
			if tool.Success && tool.Edit && (p.surface == "read-pitfall" || p.surface == "read-risk" || p.surface == "edit") {
				for _, path := range tool.Paths {
					for _, named := range target.Paths {
						decided = decided || path == named
					}
					for _, scope := range target.Scopes {
						decided = decided || pathscope.MatchesScope(scope, path)
					}
				}
				if decided {
					break
				}
			}
		}
		settled := decided || close || e.ToolCalls+len(req.SurfaceTools) >= p.expires
		if settled {
			_, err = c.ExecContext(ctx, `UPDATE surface_windows SET acted=?,settled=1 WHERE delivery_id=? AND settled=0`, acted, p.id)
			if err == nil {
				var remaining, groupActed int
				err = c.QueryRowContext(ctx, `UPDATE surface_firings SET pending=pending-1,acted=max(acted,?) WHERE id=? AND settled=0 RETURNING pending,acted`, acted, p.firing).Scan(&remaining, &groupActed)
				if err == nil && remaining == 0 {
					_, err = c.ExecContext(ctx, `UPDATE surface_firings SET settled=1 WHERE id=? AND settled=0`, p.firing)
					if err == nil {
						_, err = c.ExecContext(ctx, `UPDATE surface_stats SET settled=settled+1,acted=acted+? WHERE project_id=? AND checkout=? AND surface=? AND action=? AND repeated=?`, groupActed, p.project, p.checkout, p.surface, p.action, p.repeat)
					}
					if err == nil {
						err = surfaceCounter(ctx, c, req, "settled")
					}
					if err == nil && groupActed == 1 {
						err = surfaceCounter(ctx, c, req, "acted")
					}
				}
			}
		} else if acted != p.acted {
			_, err = c.ExecContext(ctx, `UPDATE surface_windows SET acted=1 WHERE delivery_id=? AND settled=0`, p.id)
		}
		if err != nil {
			return err
		}
	}
	e.ToolCalls += len(req.SurfaceTools)
	return nil
}

func WilsonLower(acted, total int, z float64) float64 {
	if total <= 0 {
		return 0
	}
	n := float64(total)
	p := float64(acted) / n
	return (p + z*z/(2*n) - z*math.Sqrt((p*(1-p)+z*z/(4*n))/n)) / (1 + z*z/n)
}

// GateDecision uses only settled live evidence. Missing controls cannot pass
// or fail. Missing repeats cannot pass; primary efficacy checks can still fail.
//
// A surface that fires once per session by construction has no repeats to
// compare, so for it the repeat rule is not applicable rather than pending.
func GateDecision(total, acted, first, firstActed, repeats, repeatActed, baseTotal, baseActed int, oncePerSession bool) (string, string) {
	if total < 30 || baseTotal == 0 {
		return "collecting", "insufficient settled live firings, repeats or controls"
	}
	rate, base := float64(acted)/float64(total), float64(baseActed)/float64(baseTotal)
	if rate < .30 {
		return "fail", "acted below 30%"
	}
	if rate <= base || WilsonLower(acted, total, 1.959963984540054) <= base {
		return "fail", "Wilson lower bound does not exceed control rate"
	}
	if oncePerSession {
		return "pass", "acted gate passed; repeats not applicable"
	}
	if first == 0 || repeats == 0 {
		return "collecting", "insufficient first or repeat evidence"
	}
	if float64(repeatActed)/float64(repeats) < float64(firstActed)/float64(first) {
		return "fail", "repeats below first firings"
	}
	return "pass", "acted and repeat gates passed"
}
