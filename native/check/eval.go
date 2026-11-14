package check

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Roles.
const (
	Complete   = "complete"
	Supporting = "supporting"
)

// Verdicts, as stored in hooks.db.
const (
	Held    = "held"
	Changed = "changed"
	Broken  = "broken"
	Unknown = "unknown"
)

// Status is the outcome of one check.
type Status string

const (
	// Pass: the check read its target and saw what it saw when written.
	Pass Status = "pass"
	// Fail: the target is there and says something else.
	Fail Status = "fail"
	// Gone: the file, key, script or section the check names no longer exists.
	Gone Status = "gone"
	// Floor: the check can't be evaluated here (unreadable input, a kind not
	// built yet, a URL); its recorded file hashes decide.
	Floor Status = "floor"
)

// CheckResult explains one check's outcome.
type CheckResult struct {
	Index  int    `json:"index"`
	Kind   string `json:"kind"`
	Role   string `json:"role"`
	Status Status `json:"status"`
	// Reason is a short plain sentence for people, "" on a pass.
	Reason string `json:"reason,omitempty"`
	// Now is what the check reads today, when it could read it.
	Now any `json:"now,omitempty"`
	// FilesChanged lists recorded files whose hash differs today, or that
	// are missing.
	FilesChanged []string `json:"files_changed,omitempty"`
}

// Result is one entry's verdict and why.
type Result struct {
	EntryID string        `json:"entry_id"`
	Verdict string        `json:"verdict"`
	Checks  []CheckResult `json:"checks"`
	// Inputs maps every file the evaluation read to its hash today
	// ("missing" or "unreadable" when it couldn't be read).
	Inputs map[string]string `json:"inputs"`
}

// Evaluator evaluates entries against one checkout. It reads each file once.
type Evaluator struct {
	files *files
}

// NewEvaluator opens a checkout for reading. Reads never leave it.
func NewEvaluator(checkout string) (*Evaluator, error) {
	f, err := openFiles(checkout)
	if err != nil {
		return nil, err
	}
	return &Evaluator{files: f}, nil
}

// Close releases the checkout.
func (ev *Evaluator) Close() error { return ev.files.Close() }

// Evaluate gives one entry its verdict.
//
//   - A retired entry, or a complete check that fails or whose target is
//     gone, is broken.
//   - A supporting check that fails or is gone makes it changed: the judge
//     decides.
//   - A check that can't be evaluated falls back to its file hashes: any
//     recorded file that differs or is missing makes it changed; with no
//     recorded files it is unknown.
//   - Passing checks hold, even if their files changed around them.
//   - An entry with no checks is unknown: nothing tests it.
func (ev *Evaluator) Evaluate(e *Entry) Result {
	res := Result{EntryID: e.ID, Checks: make([]CheckResult, 0, len(e.Checks)), Inputs: map[string]string{}}
	verdict := Held
	raise := func(v string) {
		if rank(v) > rank(verdict) {
			verdict = v
		}
	}
	if e.Status == "retired" {
		raise(Broken)
	}
	if len(e.Checks) == 0 {
		raise(Unknown)
	}
	for i, c := range e.Checks {
		r := ev.run(c)
		r.Index, r.Kind, r.Role = i, c.Kind, c.Role
		r.FilesChanged = ev.floor(c, res.Inputs)
		switch r.Status {
		case Fail, Gone:
			if c.Role == Complete {
				raise(Broken)
			} else {
				raise(Changed)
			}
		case Floor:
			switch {
			case len(r.FilesChanged) > 0:
				raise(Changed)
			case len(c.Files) == 0:
				raise(Unknown)
			}
		}
		res.Checks = append(res.Checks, r)
	}
	res.Verdict = verdict
	return res
}

func rank(v string) int {
	switch v {
	case Broken:
		return 3
	case Changed:
		return 2
	case Unknown:
		return 1
	}
	return 0
}

// floor compares a check's recorded file hashes with today's, and notes
// every file read in inputs.
func (ev *Evaluator) floor(c Check, inputs map[string]string) []string {
	var changed []string
	for path, want := range c.Files {
		r := ev.files.read(path)
		inputs[path] = inputState(r)
		if r.hash != want {
			changed = append(changed, path)
		}
	}
	sort.Strings(changed)
	return changed
}

func inputState(r fileRead) string {
	switch {
	case errors.Is(r.err, errMissing):
		return "missing"
	case r.err != nil:
		return "unreadable"
	}
	return r.hash
}

func (ev *Evaluator) run(c Check) CheckResult {
	switch c.Kind {
	case "key":
		return ev.key(c)
	case "command":
		return ev.command(c)
	case "section":
		return ev.section(c)
	case "source":
		return ev.source(c)
	}
	return CheckResult{Status: Floor, Reason: fmt.Sprintf("%s checks are not evaluated yet", c.Kind)}
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// readTarget reads the check's target file, mapping read problems to a
// result. ok is false when the caller should return res.
func (ev *Evaluator) readTarget(file string) (data []byte, res CheckResult, ok bool) {
	r := ev.files.read(file)
	switch {
	case errors.Is(r.err, errMissing):
		return nil, CheckResult{Status: Gone, Reason: file + " no longer exists"}, false
	case r.err != nil:
		return nil, CheckResult{Status: Floor, Reason: file + " can't be read"}, false
	}
	return r.data, CheckResult{}, true
}

// key: the value at a JSON Pointer in a JSON or YAML file.
func (ev *Evaluator) key(c Check) CheckResult {
	file, pointer := str(c.Target, "file"), str(c.Target, "pointer")
	data, res, ok := ev.readTarget(file)
	if !ok {
		return res
	}
	doc, err := parseConfig(file, data)
	if err != nil {
		return CheckResult{Status: Floor, Reason: file + " can't be parsed"}
	}
	now, found := resolvePointer(doc, pointer)
	if !found {
		return CheckResult{Status: Gone, Reason: fmt.Sprintf("%s has no %s", file, pointer)}
	}
	if !equalValues(now, c.Saw["value"]) {
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%s %s changed", file, pointer), Now: now}
	}
	return CheckResult{Status: Pass, Now: now}
}

// command: the script, target or step a command runs still exists.
func (ev *Evaluator) command(c Check) CheckResult {
	file, pointer := str(c.Target, "file"), str(c.Target, "pointer")
	data, res, ok := ev.readTarget(file)
	if !ok {
		return res
	}
	exists := false
	if isMakefile(file) {
		exists = makeTargets(data)[strings.TrimPrefix(strings.ReplaceAll(strings.ReplaceAll(pointer, "~1", "/"), "~0", "~"), "/")]
	} else {
		doc, err := parseConfig(file, data)
		if err != nil {
			return CheckResult{Status: Floor, Reason: file + " can't be parsed"}
		}
		value, found := resolvePointer(doc, pointer)
		if s, isString := value.(string); found && (!isString || strings.TrimSpace(s) != "") {
			exists = true
		}
	}
	want, _ := c.Saw["exists"].(bool)
	switch {
	case exists == want:
		return CheckResult{Status: Pass, Now: exists}
	case !exists:
		return CheckResult{Status: Gone, Reason: fmt.Sprintf("%s no longer defines %s", file, pointer), Now: false}
	}
	return CheckResult{Status: Fail, Reason: fmt.Sprintf("%s now defines %s", file, pointer), Now: true}
}

// section: a Markdown section's text, ignoring whitespace.
func (ev *Evaluator) section(c Check) CheckResult {
	file, title := str(c.Target, "file"), str(c.Target, "heading")
	data, res, ok := ev.readTarget(file)
	if !ok {
		return res
	}
	body, found := section(data, title)
	if !found {
		return CheckResult{Status: Gone, Reason: fmt.Sprintf("%s has no section %q", file, title)}
	}
	now := textHash(body)
	if now != str(c.Saw, "hash") {
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("section %q of %s was edited", title, file), Now: now}
	}
	return CheckResult{Status: Pass, Now: now}
}

// source: the file a rule came from, unedited apart from whitespace. URL
// sources need the network, which the free stage never uses.
func (ev *Evaluator) source(c Check) CheckResult {
	file := str(c.Target, "file")
	if file == "" {
		return CheckResult{Status: Floor, Reason: "URL sources are checked by the weekly network pass"}
	}
	data, res, ok := ev.readTarget(file)
	if !ok {
		return res
	}
	now := textHash(string(data))
	if now != str(c.Saw, "hash") {
		return CheckResult{Status: Fail, Reason: file + " was edited", Now: now}
	}
	return CheckResult{Status: Pass, Now: now}
}
