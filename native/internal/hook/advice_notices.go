package hook

import (
	"fmt"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

// Advisory lines are local to this checkout and branch. Unlike a fix preview,
// they deliberately survive HEAD advancing and belong to the next new session.
func adviceNotice(ev contract.Event, h home, directory string) ([]string, string) {
	if ev.Kind != contract.SessionStart || (ev.Source != "" && ev.Source != "startup") || ev.SessionID == "" || ev.AgentID != "" {
		return nil, ""
	}
	ids := localrecord.AdviceIDs(directory, ev.Checkout)
	if len(ids) == 0 {
		return nil, ""
	}
	at, ok := judgeGitPosition(ev.Checkout)
	if !ok {
		return nil, ""
	}
	location := hooksLocation(h, directory)
	reader, err := localrecord.OpenRecord(location)
	if err != nil {
		return nil, ""
	}
	defer reader.Close()
	hooks, err := localrecord.OpenHooks(location)
	if err != nil {
		return nil, ""
	}
	defer hooks.Close()
	var pending []string
	for _, a := range reader.Advice(ev.ProjectID, ev.Checkout, at.Branch, ids) {
		same := false
		for _, r := range a.Receipts {
			if r.Session == ev.SessionID {
				same = true
				break
			}
		}
		if same {
			continue
		}
		shown, err := hooks.NoticeShown(a.ID)
		if err != nil {
			return nil, ""
		}
		if !shown {
			pending = append(pending, a.ID)
		}
	}
	if len(pending) == 0 {
		return nil, ""
	}
	if current, ok := judgeGitPosition(ev.Checkout); !ok || current != at {
		return nil, ""
	}
	return pending, fmt.Sprintf("MEX · %d local advisories about advice used earlier on %s · details: mex report", len(pending), strings.TrimPrefix(at.Branch, "refs/heads/"))
}
