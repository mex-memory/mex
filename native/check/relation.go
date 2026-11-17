package check

import (
	"fmt"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/index"
	pathscope "github.com/mex-memory/mex/native/internal/scope"
)

// relationCheck: a relation between two parts of the code, counted. The
// usual one is a boundary ("core never imports adapters"), recorded as
// count 0. Imports are read from the file index; queries that need resolved
// calls wait for the code graph and fall back to the file hashes.
func (ev *Evaluator) relationCheck(c Check) CheckResult {
	count, res, ok := ev.relationCount(c.Target, c.Saw)
	if !ok {
		return res
	}
	if want, ok := savedCount(c.Saw); !ok || want != float64(count.n) {
		return CheckResult{Status: Fail, Reason: count.reason(c.Target), Now: count.n}
	}
	return CheckResult{Status: Pass, Now: count.n}
}

type relationCount struct {
	n     int
	first index.ImportEdge
}

func (rc relationCount) reason(target map[string]any) string {
	if rc.n == 0 {
		return fmt.Sprintf("%s no longer imports %s", str(target, "from"), str(target, "to"))
	}
	more := ""
	if rc.n > 1 {
		more = fmt.Sprintf(" (%d imports in all)", rc.n)
	}
	return fmt.Sprintf("%s imports %s%s", rc.first.From, rc.first.To, more)
}

// relationCount counts the relation today. saw, when given, lets a partial
// read still fail: imports already found beyond the recorded count are
// proof, while fewer can't be told apart from imports in unread files.
func (ev *Evaluator) relationCount(target, saw map[string]any) (relationCount, CheckResult, bool) {
	query := str(target, "query")
	if query != "imports" {
		return relationCount{}, CheckResult{Status: Floor, Reason: fmt.Sprintf("%q relations need the code graph", query)}, false
	}
	if ev.index == nil {
		return relationCount{}, CheckResult{Status: Floor, Reason: "no file index for relation checks"}, false
	}
	to, err := pathscope.CompileGlob(pathscope.Normalize(str(target, "to")))
	if err != nil {
		return relationCount{}, CheckResult{Status: Floor, Reason: "invalid relation target"}, false
	}
	answer, err := ev.index.ImportsFrom(str(target, "from"))
	if err != nil {
		return relationCount{}, CheckResult{Status: Floor, Reason: "the file index can't be read"}, false
	}
	var count relationCount
	for _, edge := range answer.Edges {
		if to.MatchString(edge.To) {
			if count.n == 0 {
				count.first = edge
			}
			count.n++
		}
	}
	if unread := unreadSummary(answer.Unread); unread != "" {
		if want, ok := savedCount(saw); ok && float64(count.n) > want {
			return count, CheckResult{}, true
		}
		return relationCount{}, CheckResult{Status: Floor, Reason: "imports unknown: " + unread}, false
	}
	return count, CheckResult{}, true
}

func savedCount(saw map[string]any) (float64, bool) {
	v, err := normalize(saw["count"])
	n, ok := v.(float64)
	return n, err == nil && ok
}

// unreadSummary names why files couldn't be read, most common first.
func unreadSummary(unread map[string]int) string {
	reasons := make([]string, 0, len(unread))
	for reason := range unread {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(i, j int) bool {
		if unread[reasons[i]] != unread[reasons[j]] {
			return unread[reasons[i]] > unread[reasons[j]]
		}
		return reasons[i] < reasons[j]
	})
	parts := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		files := "files"
		if unread[reason] == 1 {
			files = "file"
		}
		parts = append(parts, fmt.Sprintf("%d %s %s", unread[reason], files, reason))
	}
	return strings.Join(parts, ", ")
}
