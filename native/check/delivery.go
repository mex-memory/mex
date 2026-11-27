package check

import (
	"strings"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/judgement"
	"github.com/mex-memory/mex/native/internal/rulechange"
	pathscope "github.com/mex-memory/mex/native/internal/scope"
)

const (
	deliveryFiles     = 16
	deliveryFileBytes = 256 << 10
	deliveryWitnesses = 8
)

// CurrentLearnedVerdict checks a matched candidate against the worktree. The
// stage key saves re-evaluation when it covers all the inputs; existence checks
// and symbol relinks need a separate proof because an index can lag the disk.
// Folder and glob pattern counts come from the file index, as they do in the
// check stage: its snapshot is part of the key, so a refresh re-evaluates.
// Unknown tells the caller to send a pointer. This check never writes verdicts.
func CurrentLearnedVerdict(checkout, directory, project string, item *entries.Item, path, cachedInputs string, model bool, deadline time.Time) string {
	inTime := func() bool { return time.Now().Before(deadline) }
	if !inTime() || len(item.Entry.Checks) == 0 {
		return Unknown
	}
	e := &Entry{ID: item.Entry.ID, Status: item.Entry.Status, When: item.Entry.When}
	paths := map[string]bool{}
	needsIndex, hasSymbol := false, false
	for _, c := range item.Entry.Checks {
		c := Check(c)
		switch c.Kind {
		case "relation":
			// A cached graph or index can miss edits anywhere in the relation.
			return Unknown
		case "pattern":
			needsIndex = true
		case "symbol":
			needsIndex, hasSymbol = true, true
		case "scope":
			needsIndex = true
		}
		e.Checks = append(e.Checks, c)
		for _, file := range targetFiles(c) {
			paths[file] = true
		}
		if len(paths) > deliveryFiles {
			return Unknown
		}
	}

	ev, err := NewEvaluator(checkout)
	if err != nil {
		return Unknown
	}
	defer ev.Close()
	ev.files.maxBytes = deliveryFileBytes
	if model {
		ev.files.maxBytes = judgement.MaxEvidenceFileBytes
	}
	ev.deliveryScopes = map[string]bool{}
	closeRecords, _ := ev.useURLRecords(directory, project, false)
	defer closeRecords()
	asOf := ""
	if needsIndex {
		if ix, err := index.Open(directory, project, checkout); err == nil {
			defer ix.Close()
			ev.UseIndex(ix)
			asOf = ix.AsOf()
		}
	}
	for file := range paths {
		if !inTime() {
			return Unknown
		}
		if !ev.liveFile(file) || ev.files.read(file).err != nil {
			return Unknown
		}
	}
	for _, c := range e.Checks {
		if !inTime() {
			return Unknown
		}
		switch c.Kind {
		case "scope":
			glob := str(c.Target, "glob")
			if ev.deliveryScopes[glob] {
				continue
			}
			// A scope check only needs one live file. Reuse the matched path
			// or a named input so broad scopes never require a directory walk;
			// failing both, a few paths the index lists, each checked on disk.
			witness := false
			if pathscope.Literal(glob) {
				witness = ev.liveFile(pathscope.Normalize(glob))
			} else if re, err := pathscope.CompileGlob(glob); err == nil {
				witness = re.MatchString(path) && ev.liveFile(path)
				for file := range paths {
					witness = witness || re.MatchString(file)
				}
				if !witness {
					witness = ev.liveIndexedPath(glob)
				}
			}
			if !witness {
				return Unknown
			}
			ev.deliveryScopes[glob] = true
		case "source":
			// A URL observation can expire even while its recorded state
			// stays the same. The local observation is all a hook may use.
			if str(c.Target, "url") != "" && ev.urlCheck(c).Status == Floor {
				return Unknown
			}
		}
	}

	// The stage adds the rule-change signal for every stored level, so the
	// keys only compare equal with it.
	inputs := ev.inputsHash(Loaded{Hash: item.Hash, Entry: e}, asOf)
	if item.Level != Hint {
		inputs = withRuleSignal(inputs, rulechange.Read(directory, project, checkout).For(e.ID, item.Hash))
	}
	if !inTime() {
		return Unknown
	}
	if !hasSymbol && inputs == cachedInputs {
		return Held
	}
	if model && inputs != cachedInputs {
		return Unknown
	}
	result := ev.Evaluate(e)
	if !inTime() {
		return Unknown
	}
	for _, c := range result.Checks {
		if c.Status == Floor || c.Kind == "symbol" && c.Status == Gone {
			return Unknown
		}
	}
	if model && result.Verdict == Changed {
		return Held
	}
	return result.Verdict
}

// liveIndexedPath proves a broad scope when no matched or named file did:
// one of a few indexed paths that is still a file on disk.
func (ev *Evaluator) liveIndexedPath(glob string) bool {
	ix, ok := ev.index.(interface {
		PathsMatching(string, int) ([]string, bool, error)
	})
	if !ok {
		return false
	}
	paths, _, err := ix.PathsMatching(glob, deliveryWitnesses)
	if err != nil {
		return false
	}
	for _, p := range paths {
		if ev.liveFile(p) {
			return true
		}
	}
	return false
}

func (ev *Evaluator) liveFile(path string) bool {
	if !safeRelative(path) {
		return false
	}
	info, err := ev.files.root.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// Old exact literal counts use the indexer's raw, non-overlapping semantics.
func (ev *Evaluator) liveLiteralCount(file, literal string) (int, CheckResult, bool) {
	data, res, ok := ev.readTarget(file)
	if !ok {
		return 0, res, false
	}
	return strings.Count(string(data), literal), CheckResult{}, true
}
