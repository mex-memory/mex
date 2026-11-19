package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path"
	"strings"
	"unicode"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// Intent is an epoch observation, not a prediction about the person's goal.
// Only existing database paths persist it; a silent event stays silent.
func observeIntent(previous string, ev contract.Event, g *group) string {
	if previous == "" {
		previous = "investigating"
	}
	if ev.Kind == contract.Prompt && ev.Prompt != nil && ev.Prompt.Typed {
		ws := strings.FieldsFunc(strings.ToLower(ev.Prompt.Text), func(r rune) bool { return !unicode.IsLetter(r) })
		for _, w := range ws {
			switch w {
			case "replace", "migrate", "remove", "rename", "deprecate":
				return "changing"
			case "reproduce", "repro":
				return "reproducing"
			}
		}
		if strings.Contains(strings.ToLower(ev.Prompt.Text), "failing test") {
			return "reproducing"
		}
	}
	// A shell command that broke a strong rule edited files: edit risk.
	if len(g.shellEdits) > 0 && previous == "investigating" {
		previous = "working"
	}
	for _, v := range g.views {
		if !isEdit(v) {
			continue
		}
		if dependencyRemoved(v) {
			return "changing"
		}
		for i := range g.snap.Items {
			it := &g.snap.Items[i]
			if inScope(it, v.rel) && g.snap.Patterns().InEdit(boundedText(v.removed, 32768), it, "anti") && !g.snap.Patterns().InEdit(boundedText(v.added, 32768), it, "anti") {
				return "changing"
			}
			// The agent went past a speed bump and made the edit: the rule
			// is being changed on purpose.
			if g.deliberate[it.Entry.ID] && inScope(it, v.rel) && g.snap.Patterns().InEdit(boundedText(v.added, 32768), it, "anti") {
				return "changing"
			}
		}
		if previous == "investigating" {
			previous = "working"
		}
	}
	return previous
}

// Only structured dependency sections prove a removal. An isolated deleted
// JSON property could be a script or configuration, so it is not intent evidence.
func dependencyRemoved(v toolView) bool {
	if path.Base(v.rel) != "package.json" || len(v.removed) > 32768 || len(v.added) > 32768 {
		return false
	}
	decode := func(text string) map[string]json.RawMessage {
		var value map[string]json.RawMessage
		if json.Unmarshal([]byte(text), &value) != nil {
			_ = json.Unmarshal([]byte("{"+text+"}"), &value)
		}
		return value
	}
	old, next := decode(v.removed), decode(v.added)
	for _, section := range []string{"dependencies", "devDependencies", "peerDependencies", "optionalDependencies"} {
		var before, after map[string]json.RawMessage
		if json.Unmarshal(old[section], &before) != nil {
			continue
		}
		// An absent section in a replacement fragment is not proof it was removed.
		if raw, ok := next[section]; ok {
			if json.Unmarshal(raw, &after) != nil {
				continue
			}
		} else if strings.TrimSpace(v.added) != "" && next == nil {
			continue
		}
		for name := range before {
			if _, ok := after[name]; !ok {
				return true
			}
		}
	}
	return false
}

func commandObservations(g *group) (commands []string, failed string) {
	for _, v := range g.views {
		if v.name != contract.ToolShell || v.command == "" || len(v.command) > 8192 {
			continue
		}
		digest := sha256.Sum256([]byte(g.project + "\n" + g.checkout + "\n" + v.path + "\n" + v.command))
		key := hex.EncodeToString(digest[:])
		commands = append(commands, key)
		if v.failed {
			failed = key
		}
	}
	return commands, failed
}

func deliveredObservations(h *record.Hooks, ev contract.Event, g *group) ([]record.FollowupObservation, []string, error) {
	rows, err := h.ProbeEntries(ev.SessionID, ev.AgentID, g.project, g.checkout)
	if err != nil {
		return nil, nil, err
	}
	var probes []record.FollowupObservation
	var touches []string
	type observedEffect struct{ kind, detail string }
	var effects []observedEffect
	for _, v := range g.views {
		if kind, detail := adviceEffect(v); kind != "" {
			effects = append(effects, observedEffect{kind, detail})
		}
	}
	work, scan := 0, 0
	for _, row := range rows {
		for _, effect := range effects {
			if len(probes) < 900 {
				probes = append(probes, record.FollowupObservation{EntryID: row.EntryID, ReceiptID: row.ID, Kind: effect.kind, Detail: effect.detail})
			}
		}
		for i := range g.snap.Items {
			it := &g.snap.Items[i]
			if it.Entry.ID != row.EntryID {
				continue
			}
			kinds := map[string]bool{}
			touched := false
			for _, v := range g.views {
				work++
				scan += len(boundedText(v.added, 32768)) + len(boundedText(v.command, 8192))
				if work > 10000 || scan > 8<<20 {
					return probes, touches, nil
				}
				if v.rel != "" && inScope(it, v.rel) && (v.name == contract.ToolRead || isEdit(v)) {
					touched = true
				}
				if isEdit(v) && inScope(it, v.rel) && g.snap.Patterns().InEdit(boundedText(v.added, 32768), it, "anti") {
					kinds["missed"] = true
				}
				if v.name == contract.ToolShell && folderInScope(it, v.rel) {
					if it.Entry.Kind == "recipe" {
						for _, cmd := range recipeCommands(it.Entry) {
							if strings.TrimSpace(v.command) == strings.TrimSpace(cmd) {
								kinds["followed"] = true
							}
						}
					}
					for _, kind := range []string{"opened", "wrong"} {
						command := "mex expand "
						if kind == "wrong" {
							command = "mex wrong "
						}
						if strings.TrimSpace(v.command) == command+row.EntryID {
							kinds[kind] = true
						}
					}
				}
			}
			for _, kind := range []string{"followed", "missed", "opened", "wrong"} {
				if kinds[kind] && len(probes) < 1000 {
					probes = append(probes, record.FollowupObservation{EntryID: row.EntryID, ReceiptID: row.ID, Kind: kind})
				}
			}
			if touched && len(touches) < 1000 {
				touches = append(touches, row.ID)
			}
			break
		}
	}
	return probes, touches, nil
}
