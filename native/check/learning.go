package check

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/pattern"
	localrecord "github.com/mex-memory/mex/native/record"
)

func fixtureCheck(c Check, when []entries.Trigger) CheckResult {
	fail := func(reason string) CheckResult { return CheckResult{Status: Fail, Reason: reason} }
	pairs, _ := c.Target["pairs"].([]any)
	proves, _ := c.Target["proves"].([]any)
	if len(pairs) < 1 || len(pairs) > 3 || len(proves) < 1 || len(proves) > 32 {
		return fail("invalid before and after fixture")
	}
	type trigger struct {
		required bool
		match    func(string) bool
	}
	var tests []trigger
	for _, value := range proves {
		number, _ := normalize(value)
		index, ok := number.(float64)
		if !ok || index < 0 || index >= float64(len(when)) || math.Trunc(index) != index {
			return fail("the fixture names a missing trigger")
		}
		w := when[int(index)]
		matcher, err := pattern.Matcher(w.Match, w.Pattern)
		if err != nil || w.Type != "anti" && w.Type != "rejected" && w.Type != "required" {
			return fail("the fixture names an invalid trigger")
		}
		tests = append(tests, trigger{w.Type == "required", matcher})
	}
	bytes := 0
	for _, value := range pairs {
		pair, _ := value.(map[string]any)
		before, _ := pair["before"].(map[string]any)
		after, _ := pair["after"].(map[string]any)
		b, a := str(before, "text"), str(after, "text")
		bytes += len(b) + len(a)
		if b == "" || a == "" || bytes > 12*1024 {
			return fail("invalid before and after fixture")
		}
		for _, test := range tests {
			if test.required && !test.match(a) || !test.required && (!test.match(b) || test.match(a)) {
				return fail("the current trigger no longer passes its before and after fixture")
			}
		}
	}
	return CheckResult{Status: Pass, Now: true}
}

func (ev *Evaluator) scopeCheck(c Check) CheckResult {
	ix, ok := ev.index.(interface {
		PathsMatching(string, int) ([]string, bool, error)
	})
	if !ok {
		return CheckResult{Status: Floor, Reason: "no file index for scope checks"}
	}
	if ev.indexBehindHead() {
		return CheckResult{Status: Floor, Reason: "the file index is catching up with a new commit"}
	}
	paths, _, err := ix.PathsMatching(str(c.Target, "glob"), math.MaxInt)
	if err != nil {
		return CheckResult{Status: Floor, Reason: "the file index can't count this scope"}
	}
	if len(paths) == 0 {
		return CheckResult{Status: Gone, Reason: "no indexed files match the scope", Now: 0}
	}
	return CheckResult{Status: Pass, Now: len(paths)}
}

// CandidateVerdict checks the scope exception only for a selected candidate
// without a settled verdict. A missing cache is not evidence that fix and
// fixture checks passed.
func CandidateVerdict(checkout, directory, project string, ix Index, entry *entries.Entry) (string, bool) {
	e := &Entry{ID: entry.ID, Status: entry.Status, When: entry.When}
	for _, c := range entry.Checks {
		e.Checks = append(e.Checks, Check{Kind: c.Kind, Role: c.Role, Target: c.Target, Saw: c.Saw, Files: c.Files})
	}
	ev, err := NewEvaluator(checkout)
	if err != nil {
		return Unknown, false
	}
	defer ev.Close()
	closeRecords, _ := ev.useURLRecords(directory, project, false)
	defer closeRecords()
	ev.UseIndex(ix)
	result := ev.Evaluate(e)
	for _, c := range result.Checks {
		if c.Kind == "scope" && c.Status == Pass {
			return result.Verdict, true
		}
	}
	return result.Verdict, false
}

func normalizeQuote(s string) string { return strings.Join(strings.Fields(s), " ") }

// quoteOffset chooses the occurrence whose immediate context best matches.
// A reworded heading or context need not invalidate an intact passage.
func quoteOffset(text, exact, prefix, suffix string) int {
	if exact == "" {
		return -1
	}
	best, score := -1, -1
	for start := 0; start < len(text); {
		at := strings.Index(text[start:], exact)
		if at < 0 {
			break
		}
		at += start
		after := at + len(exact)
		match := 0
		if prefix != "" && strings.HasSuffix(strings.TrimRight(text[:at], " "), prefix) {
			match++
		}
		if suffix != "" && strings.HasPrefix(strings.TrimLeft(text[after:], " "), suffix) {
			match++
		}
		if match > score {
			best, score = at, match
		}
		if score == 2 || prefix == "" && suffix == "" {
			break
		}
		start = at + 1
	}
	return best
}

type shingle struct{ first, second string }

// editedQuote finds the same-length word window with the most adjacent word
// pairs in common. Updating a multiset as the window moves keeps the scan
// linear in the file size, including a document with repeated phrases.
func editedQuote(text, exact string) string {
	original, words := strings.Fields(exact), strings.Fields(text)
	size := len(original)
	if size < 3 || len(words) < size {
		return ""
	}
	wanted, seen := map[shingle]int{}, map[shingle]int{}
	for i := 1; i < size; i++ {
		wanted[shingle{original[i-1], original[i]}]++
	}
	best, found, overlap := -1, 0, 0
	for i := 1; i < len(words); i++ {
		add := shingle{words[i-1], words[i]}
		if max := wanted[add]; max != 0 {
			if seen[add] < max {
				overlap++
			}
			seen[add]++
		}
		if i >= size {
			old := shingle{words[i-size], words[i-size+1]}
			if max := wanted[old]; max != 0 {
				if seen[old] <= max {
					overlap--
				}
				seen[old]--
			}
		}
		if i >= size-1 && overlap > found {
			best, found = i-size+1, overlap
		}
	}
	if best < 0 || 5*found < 3*(size-1) {
		return ""
	}
	return strings.Join(words[best:best+size], " ")
}

func (ev *Evaluator) quoteCheck(c Check) CheckResult {
	data, res, ok := ev.readTarget(str(c.Target, "file"))
	if !ok {
		return res
	}
	exact := normalizeQuote(str(c.Target, "exact"))
	if exact == "" {
		return CheckResult{Status: Floor, Reason: "the quote is empty"}
	}
	text := normalizeQuote(string(data))
	if quoteOffset(text, exact, normalizeQuote(str(c.Target, "prefix")), normalizeQuote(str(c.Target, "suffix"))) >= 0 {
		return CheckResult{Status: Pass, Now: textHash(exact)}
	}
	if heading := str(c.Target, "heading"); heading != "" {
		var found bool
		text, found = section(data, heading)
		if !found {
			return CheckResult{Status: Gone, Reason: "the quoted passage no longer exists"}
		}
	}
	if edited := editedQuote(text, exact); edited != "" {
		return CheckResult{Status: Fail, Reason: "the quoted passage was edited", Now: edited}
	}
	return CheckResult{Status: Gone, Reason: "the quoted passage no longer exists"}
}

var versionSyntax = lazy(`^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func compareNumeric(a, b string) int {
	a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}

func compareVersions(a, b string) (int, bool) {
	if len(a) > 128 || len(b) > 128 || !versionSyntax().MatchString(a) || !versionSyntax().MatchString(b) {
		return 0, false
	}
	split := func(s string) ([]string, string) {
		s, _, _ = strings.Cut(strings.TrimPrefix(s, "v"), "+")
		number, prerelease, _ := strings.Cut(s, "-")
		return strings.Split(number, "."), prerelease
	}
	alpha, ap := split(a)
	beta, bp := split(b)
	for i := 0; i < max(len(alpha), len(beta)); i++ {
		left, right := "0", "0"
		if i < len(alpha) {
			left = alpha[i]
		}
		if i < len(beta) {
			right = beta[i]
		}
		if cmp := compareNumeric(left, right); cmp != 0 {
			return cmp, true
		}
	}
	if ap == "" || bp == "" {
		return strings.Compare(bp, ap), true
	}
	as, bs := strings.Split(ap, "."), strings.Split(bp, ".")
	numeric := func(s string) bool { return strings.Trim(s, "0123456789") == "" }
	for i := 0; i < min(len(as), len(bs)); i++ {
		x, y := as[i], bs[i]
		switch {
		case numeric(x) && numeric(y):
			if n := compareNumeric(x, y); n != 0 {
				return n, true
			}
		case numeric(x):
			return -1, true
		case numeric(y):
			return 1, true
		default:
			if n := strings.Compare(x, y); n != 0 {
				return n, true
			}
		}
	}
	return len(as) - len(bs), true
}

func (ev *Evaluator) untilCheck(c Check) CheckResult {
	file, pointer := str(c.Target, "file"), str(c.Target, "pointer")
	data, res, ok := ev.readTarget(file)
	if !ok {
		return res
	}
	doc, err := parseConfig(file, data)
	if err != nil {
		return CheckResult{Status: Floor, Reason: file + " can't be parsed"}
	}
	raw, found := resolvePointer(doc, pointer)
	if !found {
		return CheckResult{Status: Gone, Reason: file + " has no value at " + pointer}
	}
	current, _ := raw.(string)
	cmp, valid := compareVersions(current, str(c.Target, "version"))
	if !valid {
		return CheckResult{Status: Floor, Reason: file + " has an invalid version at " + pointer}
	}
	if cmp >= 0 {
		return CheckResult{Status: Fail, Reason: "the version limit was reached", Now: current}
	}
	return CheckResult{Status: Pass, Now: current}
}

type urlObservation struct {
	State string `json:"state"`
	At    string `json:"at"`
}

// Open the record only when a URL check is evaluated, then use a consistent
// observation for cache identity and evaluation within this stage.
// An explicit check gets its own read budget, and failed reports a record it
// couldn't read; a live hook treats that as no observation.
func (ev *Evaluator) useURLRecords(directory, project string, explicit bool) (closeRecords func(), failed func() error) {
	var db *localrecord.Reader
	var readErr error
	if directory == "" || project == "" {
		return func() {}, func() error { return nil }
	}
	openRecord := localrecord.OpenRecord
	if explicit {
		openRecord = localrecord.OpenEvaluationRecord
	}
	tried := false
	cache := make(map[string]urlObservation)
	ev.urlSource = func(url, capturedHash string) (urlObservation, bool) {
		if !tried {
			tried = true
			path := filepath.Join(directory, "record.db")
			if safefile.Regular(path) {
				db, readErr = openRecord(localrecord.Location{Record: path, Directory: directory})
			}
		}
		if db == nil {
			return urlObservation{}, false
		}
		key := "learning.deep.url." + strings.TrimPrefix(hashBytes([]byte(url+"\n"+capturedHash)), "sha256:")
		row, seen := cache[key]
		if !seen {
			raw, _, err := db.BoundedSetting(project, key, 512)
			if err != nil {
				readErr = err
			}
			if json.Unmarshal([]byte(raw), &row) != nil {
				row = urlObservation{}
			}
			if _, err := time.Parse(time.RFC3339Nano, row.At); err != nil {
				row = urlObservation{}
			}
			cache[key] = row
		}
		return row, row.State != ""
	}
	return func() {
			if db != nil {
				_ = db.Close()
			}
		}, func() error {
			if !explicit || errors.Is(readErr, os.ErrNotExist) {
				return nil
			}
			return readErr
		}
}

func (ev *Evaluator) urlCheck(c Check) CheckResult {
	if ev.urlSource != nil {
		captured := str(c.Saw, "hash")
		if row, ok := ev.urlSource(str(c.Target, "url"), captured); ok {
			switch row.State {
			case "same":
				return CheckResult{Status: Pass, Now: captured}
			case "edited":
				return CheckResult{Status: Fail, Reason: "the linked source was edited"}
			case "deleted":
				return CheckResult{Status: Gone, Reason: "the linked source no longer exists"}
			}
		}
	}
	return CheckResult{Status: Floor, Reason: "URL sources are checked by the weekly network pass"}
}

// SymbolRelink identifies the current declaration so a background job can
// prepare a verified write without parsing a human-readable reason.
type SymbolRelink struct {
	File   string `json:"file"`
	Symbol string `json:"symbol"`
}
