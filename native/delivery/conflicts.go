package delivery

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

func sourcePriority(s shaped) int {
	if s.item.Level == "personal" {
		return 3
	}
	if s.item.Entry.Source.Type == "rule-file" {
		return 2
	}
	if s.item.Level == "hint" || s.item.Entry.Kind == "hint" {
		return 0
	}
	return 1
}
func conflictBefore(a, b shaped) bool {
	if sourcePriority(a) != sourcePriority(b) {
		return sourcePriority(a) > sourcePriority(b)
	}
	if evidence(a) != evidence(b) {
		return evidence(a) > evidence(b)
	}
	return a.item.Entry.ID < b.item.Entry.ID
}
func overlapping(a, b shaped) bool {
	for _, x := range a.item.Entry.Scope {
		for _, y := range b.item.Entry.Scope {
			px, py := x, y
			if i := strings.IndexAny(px, "*?[]{}"); i >= 0 {
				px = px[:i]
			}
			if i := strings.IndexAny(py, "*?[]{}"); i >= 0 {
				py = py[:i]
			}
			if strings.HasPrefix(px, py) || strings.HasPrefix(py, px) {
				return true
			}
		}
	}
	return false
}
func disagreement(a, b shaped) string {
	if !overlapping(a, b) {
		return ""
	}
	for _, x := range a.item.Entry.When {
		for _, y := range b.item.Entry.When {
			opposed := (x.Type == "required" && (y.Type == "anti" || y.Type == "rejected")) ||
				(y.Type == "required" && (x.Type == "anti" || x.Type == "rejected"))
			if x.Match == "literal" && y.Match == "literal" && x.Pattern == y.Pattern && opposed {
				return "literal"
			}
		}
	}
	for _, x := range a.item.Entry.Checks {
		for _, y := range b.item.Entry.Checks {
			if (x.Kind != "key" && x.Kind != "value") || x.Kind != y.Kind {
				continue
			}
			tx, _ := json.Marshal(x.Target)
			ty, _ := json.Marshal(y.Target)
			vx, _ := json.Marshal(x.Saw["value"])
			vy, _ := json.Marshal(y.Saw["value"])
			if string(tx) == string(ty) && string(vx) != string(vy) {
				return "checked-value"
			}
		}
	}
	if a.item.Entry.Kind == "recipe" && b.item.Entry.Kind == "recipe" {
		for _, x := range recipeCommands(a.item.Entry) {
			for _, y := range recipeCommands(b.item.Entry) {
				nx, ny := normalizeCommand(x), normalizeCommand(y)
				if len(nx) >= 2 && len(ny) >= 2 && nx[0] == ny[0] && nx[1] == ny[1] && strings.Join(nx, " ") != strings.Join(ny, " ") {
					return "command"
				}
			}
		}
	}
	return ""
}
func resolveConflicts(items []shaped) ([]shaped, []record.DeliveryConflict) {
	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool { return conflictBefore(items[order[i]], items[order[j]]) })
	var conflicts []record.DeliveryConflict
	work := 0
outer:
	for n, i := range order {
		if items[i].action == "withheld" {
			continue
		}
		for _, j := range order[n+1:] {
			work++
			if work > 10000 {
				for _, k := range order[n+1:] {
					items[k].action, items[k].detail = "withheld", "conflict-bound"
				}
				break outer
			}
			if items[j].action == "withheld" {
				continue
			}
			if why := disagreement(items[i], items[j]); why != "" {
				loser := items[j].item.Entry.ID
				items[j].action, items[j].detail = "withheld", "conflict"
				items[i].conflicts = append(items[i].conflicts, loser)
				conflicts = append(conflicts, record.DeliveryConflict{Winner: items[i].item.Entry.ID, Loser: loser, Reason: why})
			}
		}
	}
	// The note belongs to the delivered form and is included in token accounting.
	for i := range items {
		if len(items[i].conflicts) > 0 {
			note := "\nConflicts with " + strings.Join(items[i].conflicts, ", ") + "; this source takes precedence."
			items[i].full += note
			items[i].oneLine += note
			items[i].fullTok = entries.EstimateTokens(items[i].full)
			items[i].lineTok = entries.EstimateTokens(items[i].oneLine)
		}
	}
	return items, conflicts
}
