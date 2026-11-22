package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
	"github.com/mex-memory/mex/native/workset"
)

// The bug-history notice: when the agent edits a file that has been fixed
// often and recently, one line says how often and how long ago. It is read
// from the fix table the background job writes; the hook runs no git.
const (
	historyMinFixes      = 3
	historyMaxAge        = 180 * 24 * time.Hour
	historyMaxPerSession = 3
	historyMaxFiles      = 8
)

type historyNotice struct {
	project, checkout, rel string
	fixes                  workset.Fixes
}

func hasEditTool(ev contract.Event) bool {
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	for _, t := range tools {
		switch t.Name {
		case contract.ToolEdit, contract.ToolWrite, contract.ToolPatch:
			return true
		case contract.ToolShell:
			if strings.Contains(t.Input.Command, "apply_patch") || strings.Contains(t.Input.Command, "*** Begin Patch") {
				return true
			}
		}
	}
	return false
}

// findHistory lists edited files whose fix history earns a notice. The fix
// table is opened only on an edit, and only while the surface isn't off.
func findHistory(ev contract.Event, env Environment) []historyNotice {
	if !hasEditTool(ev) {
		return nil
	}
	var out []historyNotice
	seen := map[string]bool{}
	for _, v := range views(ev, env.Resolve) {
		if len(out) == historyMaxFiles {
			break
		}
		if !isEdit(v) || v.project == "" || v.checkout == "" || seen[v.checkout+"\n"+v.rel] {
			continue
		}
		seen[v.checkout+"\n"+v.rel] = true
		if surfaceSetting(env, v.project, "bug-history") == "off" {
			continue
		}
		fx, ok := workset.FixesFor(env.RecordDirectory, v.project, v.checkout, v.rel)
		age := env.Now.Sub(fx.Last)
		if !ok || fx.Count < historyMinFixes || age > historyMaxAge || age < -24*time.Hour {
			continue
		}
		out = append(out, historyNotice{v.project, v.checkout, v.rel, fx})
	}
	return out
}

// ageText says how long ago in whole units, always with a number.
func ageText(d time.Duration) string {
	days := int(d.Hours() / 24)
	unit := func(n int, one string) string {
		if n == 1 {
			return "1 " + one + " ago"
		}
		return strconv.Itoa(n) + " " + one + "s ago"
	}
	switch {
	case days < 1:
		return "less than a day ago"
	case days < 14:
		return unit(days, "day")
	case days < 60:
		return unit(days/7, "week")
	}
	return unit(days/30, "month")
}

func historyLine(n historyNotice, now time.Time) string {
	return "History: " + n.rel + " was fixed " + strconv.Itoa(n.fixes.Count) + " times, the last " + ageText(now.Sub(n.fixes.Last)) + "."
}

// deliverHistory records each notice and renders those that were sent.
func deliverHistory(h *record.Hooks, ev contract.Event, env Environment, notices []historyNotice) (string, error) {
	byCheckout := map[string][]historyNotice{}
	var order []string
	for _, n := range notices {
		key := n.project + "\n" + n.checkout
		if _, ok := byCheckout[key]; !ok {
			order = append(order, key)
		}
		byCheckout[key] = append(byCheckout[key], n)
	}
	var blocks []string
	for _, key := range order {
		group := byCheckout[key]
		req := baseRequest(ev, env, group[0].project, group[0].checkout)
		lines := map[string]string{}
		for _, n := range group {
			line := historyLine(n, env.Now)
			sum := sha256.Sum256([]byte(n.checkout + "\x00" + n.rel))
			id := "mex:history:" + hex.EncodeToString(sum[:8])
			lines[id] = line
			req.Candidates = append(req.Candidates, record.DeliveryCandidate{EntryID: id, Moment: "edit-history", Surface: "bug-history", Form: "one-line", Action: "given",
				Tokens: entries.EstimateTokens(line), ContentHash: hex.EncodeToString(sum[:]), Target: record.SurfaceTarget{Paths: []string{n.rel}}, Title: line, Kind: "history",
				Exempt: true, SessionOnce: true, SessionMax: historyMaxPerSession})
		}
		res, err := h.CheckAndMark(req)
		if err != nil {
			return "", err
		}
		block, sent := "", []string{}
		for _, r := range res.Receipts {
			if r.Action == "given" {
				block = r.BlockID
				sent = append(sent, lines[r.EntryID])
			}
		}
		if block != "" {
			blocks = append(blocks, "[mex "+block+"]\n"+strings.Join(sent, "\n"))
		}
	}
	return strings.Join(blocks, "\n\n"), nil
}

var (
	testCommandRE = sync.OnceValue(func() *regexp.Regexp {
		return regexp.MustCompile(`(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:--filter[= ]\S+|-F\s+\S+|-w\s+\S+|--workspace[= ]\S+|workspace\s+\S+|-r|--recursive)\s+)*(?:run\s+)?test\b|npx\s+(?:vitest|jest|mocha)\b|vitest\b|jest\b|mocha\b|pytest\b|python[0-9.]*\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+(?:test|nextest)\b|dotnet\s+test\b|mvn\s+(?:\S+\s+)*test\b|gradlew?\s+(?:\S+\s+)*test\b|rspec\b|phpunit\b|tox\b|nox\b|make\s+(?:\S+\s+)*(?:test|check)\b|ctest\b)`)
	})
	gitHistoryRE = sync.OnceValue(func() *regexp.Regexp {
		return regexp.MustCompile(`^git\s+(?:-C\s+\S+\s+)?(?:log|blame|show|annotate)\b`)
	})
)

// testCommand reports a shell command that runs tests.
func testCommand(command string) bool {
	return len(command) <= 8192 && testCommandRE().MatchString(command)
}

// historyPaths lists the checkout-relative files a git history command names.
func historyPaths(command, cwd, checkout string) []string {
	var out []string
	for _, seg := range shellparse.Segments(command) {
		if !gitHistoryRE().MatchString(strings.TrimSpace(seg)) {
			continue
		}
		words := shellparse.Words(seg)
		if len(words) < 3 {
			continue
		}
		for _, w := range words[2:] {
			if strings.HasPrefix(w, "-") || (!strings.Contains(w, "/") && !strings.Contains(w, ".")) {
				continue
			}
			if rel, ok := place.RelativeToCheckout(checkout, shellparse.Resolve(cwd, w)); ok && !contains(out, rel) && len(out) < 16 {
				out = append(out, rel)
			}
		}
	}
	return out
}
