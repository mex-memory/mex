package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
)

// decisionWords marks a commit message as recording a choice. One phrase
// matches about half of all commits, so two distinct ones are the trigger.
// Node keeps the same list (src/knowledge/decisions.ts); a test compares them.
var decisionWords = []string{"adopt", "adopted", "avoid", "chose", "choose", "decide", "decided", "deprecate", "deprecated", "drop", "dropped", "in favor of", "in favour of", "instead of", "migrate to", "migrated to", "move to", "moved to", "no longer", "prefer", "rather than", "replace", "replaced", "switch to", "switched to"}

const decisionTrigger = 2

func lazyRegexp(pattern string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(pattern) })
}

// Compiled on first use: package-level compiles would cost every hook call.
var nonWord = lazyRegexp(`[^\p{L}\p{N}]+`)
var shaPattern = lazyRegexp(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var messageFlag = lazyRegexp(`--message=(?:"([^"]*)"|'([^']*)'|(\S+))`)

// DecisionWords returns the distinct decision phrases in a message, matched on
// word boundaries, ignoring case.
func DecisionWords(message string) []string {
	text := " " + strings.TrimSpace(nonWord().ReplaceAllString(strings.ToLower(message), " ")) + " "
	var out []string
	for _, w := range decisionWords {
		if strings.Contains(text, " "+w+" ") {
			out = append(out, w)
		}
	}
	return out
}

// commitMessage is the message of a `git commit -m ...` in a shell command, or
// "" when the command isn't one or the message isn't on the command line.
func commitMessage(command string) string {
	for _, segment := range shellparse.Segments(command) {
		words := shellparse.Words(segment)
		if len(words) < 2 || words[0] != "git" {
			continue
		}
		at := -1
		for i := 1; i < len(words); i++ {
			if words[i] == "commit" {
				at = i
				break
			}
			if words[i] == "-C" || words[i] == "-c" {
				i++
			} else if !strings.HasPrefix(words[i], "-") {
				break
			}
		}
		if at < 0 {
			continue
		}
		var parts []string
		for i := at + 1; i < len(words); i++ {
			w := words[i]
			switch {
			case (w == "--message" || (len(w) >= 2 && w[0] == '-' && w[1] != '-' && strings.HasSuffix(w, "m"))) && i+1 < len(words):
				// -m, and combined short flags that end in m, such as -am.
				parts = append(parts, words[i+1])
				i++
			case strings.HasPrefix(w, "--message="):
				// Words splits a quote that starts mid-word, so read it from the segment.
				if m := messageFlag().FindStringSubmatch(segment); m != nil {
					parts = append(parts, m[1]+m[2]+m[3])
				}
			case strings.HasPrefix(w, "-m") && len(w) > 2 && !strings.HasPrefix(w, "--"):
				parts = append(parts, w[2:])
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n\n")
		}
	}
	return ""
}

// claim creates a marker once; false when it already exists or can't be made.
func claim(directory, name string) bool {
	dir := filepath.Join(directory, "decision-prompts")
	if os.MkdirAll(dir, 0o700) != nil {
		return false
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	return f.Close() == nil
}
func seen(directory, name string) bool {
	_, err := os.Lstat(filepath.Join(directory, "decision-prompts", name))
	return err == nil
}
func sessionMarker(ev contract.Event) string {
	h := sha256.Sum256([]byte(ev.Agent + "\n" + ev.SessionID))
	return "s-" + hex.EncodeToString(h[:12])
}

// DecisionPrompt offers one line, at most once per session, after a commit
// whose message reads like a decision: when the commit is seen as a shell
// `git commit`, or at the next session start from the commit the background
// process noted. It never runs git; the hook stays a lookup.
func DecisionPrompt(ev contract.Event, recordDirectory string) string {
	if recordDirectory == "" || ev.SessionID == "" || ev.AgentID != "" || ev.Background {
		return ""
	}
	switch ev.Kind {
	case contract.PostTool, contract.PostToolBatch:
		tools := ev.Batch
		if ev.Tool != nil {
			tools = append(tools, *ev.Tool)
		}
		for _, t := range tools {
			if t.Name != contract.ToolShell {
				continue
			}
			if len(DecisionWords(commitMessage(t.Input.Command))) < decisionTrigger || seen(recordDirectory, sessionMarker(ev)) {
				continue
			}
			if claim(recordDirectory, sessionMarker(ev)) {
				return "If the commit you just made records a decision, save it with `mex note --decision --commit HEAD \"<the decision and its reason>\"`. It stays not yet accepted until that commit lands on the default branch."
			}
		}
	case contract.SessionStart:
		if ev.ProjectID == "" || strings.ContainsAny(ev.ProjectID, `/\:.`) {
			return ""
		}
		b, err := os.ReadFile(filepath.Join(recordDirectory, "decision-commits", ev.ProjectID+".json"))
		if err != nil || len(b) > 4096 {
			return ""
		}
		var c struct {
			Version int
			SHA     string
			Words   []string
		}
		if json.Unmarshal(b, &c) != nil || c.Version != 1 || !shaPattern().MatchString(c.SHA) || len(c.Words) < decisionTrigger {
			return ""
		}
		if seen(recordDirectory, "c-"+c.SHA) || seen(recordDirectory, sessionMarker(ev)) || !claim(recordDirectory, "c-"+c.SHA) {
			return ""
		}
		claim(recordDirectory, sessionMarker(ev))
		short := c.SHA[:7]
		return "Commit " + short + " reads like a decision. If it records one, save it with `mex note --decision --commit " + short + " \"<the decision and its reason>\"`."
	}
	return ""
}
