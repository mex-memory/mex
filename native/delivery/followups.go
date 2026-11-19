package delivery

import (
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func boundedText(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
func viewText(v toolView) string {
	text := v.rel + " " + boundedText(v.command, 8192) + " " + boundedText(v.added, 32768)
	if v.output != nil {
		text += " " + boundedText(v.output.Text, 32768)
	}
	return boundedText(text, 65536)
}

// Match only receipts that already exist. Light snapshots have the scopes,
// triggers and command checks needed here; a no-op never loads full text.
func holdbackObservations(h *record.Hooks, ev contract.Event, g *group) ([]record.FollowupObservation, error) {
	ids, err := h.HoldbackEntries(ev.SessionID, ev.AgentID, g.project, g.checkout)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	wanted := map[string][]string{}
	for _, row := range ids {
		wanted[row.EntryID] = append(wanted[row.EntryID], row.ID)
	}
	vs := g.views
	var out []record.FollowupObservation
	work := 0
	scanBytes := 0
	for i := range g.snap.Items {
		it := &g.snap.Items[i]
		if len(wanted[it.Entry.ID]) == 0 {
			continue
		}
		kinds := map[string]bool{}
		for _, v := range vs {
			if v.project != g.project || v.checkout != g.checkout {
				continue
			}
			work++
			cost := len(boundedText(v.added, 32768)) + len(boundedText(v.command, 8192))
			if v.name == contract.ToolShell && v.output != nil {
				cost += len(boundedText(v.output.Text, 32768))
			}
			scanBytes += cost * max(1, len(it.Entry.When)+len(it.Entry.Checks))
			if scanBytes > 8<<20 {
				return out, nil
			}
			if work > 10000 {
				return out, nil
			}
			if isEdit(v) && inScope(it, v.rel) && g.snap.Patterns().InEdit(boundedText(v.added, 32768), it, "anti") {
				kinds["missed"] = true
			}
			if v.name != contract.ToolShell || !folderInScope(it, v.rel) {
				continue
			}
			if it.Entry.Kind == "hint" && v.output != nil && (v.failed || (v.unknown && !readsOrSearches(v.command))) {
				for _, t := range triggers(it, "anti") {
					if signatureMatches(failureLines(boundedText(v.output.Text, 32768)), t.Pattern) {
						kinds["failure"] = true
					}
				}
			}
			if it.Entry.Kind == "recipe" {
				for _, command := range recipeCommands(it.Entry) {
					if commandMatches(boundedText(v.command, 8192), command) {
						kinds["command"] = true
						break
					}
				}
			}
		}
		// Fixed kind order, independent of map iteration.
		for _, kind := range []string{"missed", "failure", "command"} {
			if kinds[kind] {
				for _, receipt := range wanted[it.Entry.ID] {
					if len(out) < 1000 {
						out = append(out, record.FollowupObservation{EntryID: it.Entry.ID, Kind: kind, ReceiptID: receipt})
					}
				}
			}
		}
	}
	return out, nil
}
