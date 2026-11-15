package delivery

import (
	"encoding/json"
	"strings"
	"unicode"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
)

func hasAdviceEffects(views []toolView) bool {
	for _, v := range views {
		if kind, _ := adviceEffect(v); kind != "" {
			return true
		}
	}
	return false
}

// Command labels retain only a closed executable/subcommand vocabulary. Never
// retain argv, output, environment, credentials or the text of an edit.
func adviceEffect(v toolView) (string, string) {
	kind, summary, external := "", "", false
	identity := ""
	if isEdit(v) && !v.failed && v.output != nil && v.output.OK && len(v.rel) <= 384 && !strings.ContainsFunc(v.rel, unicode.IsControl) {
		kind, summary = "edit", "edited "+v.rel
		identity = v.rel + "\n" + contentHash(v.removed) + "\n" + contentHash(v.added)
	} else if v.name == contract.ToolShell && v.command != "" && len(v.command) <= 8192 {
		kind, summary = "command", "ran a shell command (arguments omitted)"
		identity = v.path + "\n" + v.command
		segments := shellparse.Segments(v.command)
		for _, segment := range segments {
			words := shellparse.Words(segment)
			if len(words) == 0 {
				continue
			}
			switch words[0] {
			case "curl", "wget", "ssh", "scp", "rsync":
				external = true
			case "git":
				if len(words) > 1 && (words[1] == "push" || words[1] == "send-email") {
					external = true
				}
			case "npm", "pnpm", "yarn", "pip", "pip3", "cargo", "go", "docker", "gh":
				if len(words) > 1 {
					switch words[1] {
					case "publish", "push", "upload", "deploy", "install", "add", "get", "release":
						external = true
					}
				}
			}
		}
		if len(segments) == 1 {
			words := shellparse.Words(segments[0])
			if len(words) > 1 {
				switch words[0] {
				case "npm", "pnpm", "yarn", "git", "go", "cargo":
					switch words[1] {
					case "install", "add", "test", "build", "run", "publish", "push", "fetch", "pull", "commit", "check":
						summary = "ran `" + words[0] + " " + words[1] + "` (arguments omitted)"
					}
				}
			}
		}
		if v.failed {
			summary += " — failed"
		} else if v.unknown || v.output == nil {
			summary += " — outcome unknown"
		}
		identity += "\n" + summary
		if external {
			summary += "; possible effects outside the repository (unverified; never undone)"
		}
	}
	if kind == "" {
		return "", ""
	}
	key := strings.TrimPrefix(contentHash(kind+"\n"+identity), "sha256:")
	data, _ := json.Marshal(record.AdviceEffect{Version: 1, Key: key, Summary: summary, External: external})
	return kind, string(data)
}

func currentCorrection(h *record.Hooks, ev contract.Event, g *group, id string) (string, error) {
	effects, partial, err := h.AdviceEffects(ev.SessionID, ev.AgentID, g.project, g.checkout, id)
	if err != nil {
		return "", err
	}
	text := "Correction: the MEX note " + id + " given earlier no longer matches the code; set it aside. When it became wrong is unknown."
	return boundedCorrection(text, effects, partial), nil
}

func boundedCorrection(text string, effects []record.AdviceEffect, partial bool) string {
	for len(effects) > 0 && entries.EstimateTokens(effectText(text, effects, partial))+8 > reservedLane {
		effects = effects[:len(effects)-1]
		partial = true
	}
	return effectText(text, effects, partial)
}

func effectText(text string, effects []record.AdviceEffect, partial bool) string {
	if len(effects) > 0 {
		text += " After delivery, observed (association only):"
	}
	for _, effect := range effects {
		text += "\n- " + effect.Summary
	}
	if partial {
		text += "\nMore observations exist; see mex report."
	}
	return text
}
