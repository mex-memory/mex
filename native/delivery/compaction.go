package delivery

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	compactionCheck = "mex:compaction-check"
	maxSummaryBytes = 256 << 10
)

type compactionEstimate struct {
	Kept      int  `json:"kept"`
	Checked   int  `json:"checked"`
	Estimated bool `json:"estimated"`
	Partial   bool `json:"partial,omitempty"`
}

type keepItem struct {
	label, text string
	exact       bool // paths and delivered entry IDs must occur as whole anchors
}

var privatePrompt = lazy(`(?i)<\s*/?\s*private\b`)

func recoverySafe(text string) bool {
	return strings.TrimSpace(text) != "" && utf8.ValidString(text) &&
		!strings.Contains(text, capture.Redacted) && !strings.Contains(strings.ToLower(text), "[mex ") &&
		!privatePrompt().MatchString(text) && capture.Redact(text) == text &&
		!strings.ContainsFunc(text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' })
}

// checkCompaction saves only counts as a control receipt in the new epoch.
// The recovery text is consumed separately on a context-capable hook.
func checkCompaction(h *record.Hooks, ev contract.Event, env Environment, epoch int) {
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	from, until, err := h.CompactionWindow(req.Session, ev.AgentID, epoch)
	if err != nil || from.IsZero() || until.Before(from) {
		return
	}
	estimate := compactionEstimate{Estimated: true}
	var missing []keepItem
	if len(ev.Summary) <= maxSummaryBytes && strings.TrimSpace(ev.Summary) != "" {
		items, partial := mustKeep(h, ev, env, req.Session, epoch, from, until)
		missing, estimate = compareCompaction(ev.Summary, items)
		estimate.Partial = partial || env.CaptureDisabled
	} else {
		estimate.Partial = true // no summary: no denominator or recovery claims
	}
	detail, _ := json.Marshal(estimate)
	req.ExpectedEpoch = &epoch
	req.Candidates = []record.DeliveryCandidate{{EntryID: compactionCheck, Moment: "compaction-check",
		Form: "one-line", Action: "control", Detail: string(detail), Mode: "on"}}
	if _, err := h.CheckAndMark(req); err != nil {
		return
	}
	if text := compactionBlock(ev, epoch, missing); text != "" && !env.CaptureDisabled {
		_ = capture.StageCompactionRecovery(ev, capture.Env{RecordDirectory: env.RecordDirectory, Now: env.Now}, epoch, text)
	}
}

func mustKeep(h *record.Hooks, ev contract.Event, env Environment, session record.Session, epoch int, from, until time.Time) ([]keepItem, bool) {
	var items []keepItem
	partial := false
	if ev.AgentID == "" && !env.CaptureDisabled {
		prompts, limited := compactionPrompts(h, env, session, from, until)
		items, partial = prompts, limited
	}
	if epoch > 0 {
		files, err := h.EpochFiles(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, epoch-1)
		partial = partial || err != nil || len(files) == 512
		for _, file := range files {
			items = append(items, keepItem{"Edited file", file, true})
		}
		given, _, err := h.EpochGiven(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, epoch-1)
		partial = partial || err != nil || len(given) == 2000
		for _, row := range given {
			if strings.HasPrefix(row.EntryID, "mx_") {
				items = append(items, keepItem{"Delivered entry ID", row.EntryID, true})
			}
		}
	}
	seen := map[string]bool{}
	unique := items[:0]
	for _, item := range items {
		if recoverySafe(item.text) && !seen[item.text] {
			seen[item.text] = true
			unique = append(unique, item)
		}
	}
	return unique, partial
}

func compactionPrompts(h *record.Hooks, env Environment, session record.Session, from, until time.Time) ([]keepItem, bool) {
	rows, limited, err := h.CompactionJournal(session, from, until)
	filter, filterErr := compactionFilter(env.RecordDirectory, session, from, until)
	byRow := make(map[int64][]record.CompactionQuote)
	for _, q := range filter.Quotes {
		if recoverySafe(q.Quote) {
			byRow[q.Row] = append(byRow[q.Row], q)
		}
	}
	var ask, failure string
	var items []keepItem
	passed := map[string]bool{}
	for _, row := range rows { // newest first, so a later pass clears a failure
		if !recoverySafe(row.Text) {
			continue
		}
		if row.Kind == "command" && row.ExitCode != nil {
			if *row.ExitCode == 0 {
				passed[row.Text] = true
			} else if failure == "" && !passed[row.Text] {
				failure = row.Text
			}
			continue
		}
		if row.Kind != "typed" || rank.Machine(row.Text) {
			continue
		}
		if ask == "" {
			ask = row.Text
		}
		if labels := byRow[row.ID]; len(labels) > 0 {
			typedAt, _ := time.Parse(time.RFC3339Nano, row.TS)
			matched := false
			for _, q := range labels {
				if q.At.Equal(typedAt) && strings.Contains(row.Text, q.Quote) {
					items = append(items, labeledQuote(q))
					matched = true
				}
			}
			delete(byRow, row.ID)
			if matched {
				continue
			}
		}
		if filterErr == nil && row.ID > filter.ProcessedThrough && row.Text != ask {
			items = append(items, keepItem{"Earlier user message", row.Text, false})
		}
	}
	// The journal can be pruned once the filter has read it. Retained exact
	// quotes still count when their provenance is inside this session window.
	for _, q := range filter.Quotes {
		if len(byRow[q.Row]) > 0 {
			items = append(items, labeledQuote(q))
		}
	}
	var priority []keepItem
	if ask != "" {
		priority = append(priority, keepItem{"Last user request", ask, false})
	}
	if failure != "" {
		priority = append(priority, keepItem{"Last failing command", failure, false})
	}
	if ask == "" || failure == "" {
		priority = append(priority, continuityFallback(env.RecordDirectory, session, from, until, ask == "", failure == "")...)
	}
	return append(priority, items...), limited || filter.Partial || err != nil || filterErr != nil
}

// A completed capture batch may prune the journal before the host compacts.
// The continuity snapshot already holds the short ask and unresolved failure.
// Only use observations proven to belong to this session and window.
func continuityFallback(directory string, session record.Session, from, until time.Time, needAsk, needFailure bool) []keepItem {
	branch := capture.Branch(session.Checkout)
	if branch == "" {
		return nil
	}
	state, ok := capture.ReadContinuity(directory, session.Checkout, branch)
	if !ok || state.Session != session.SessionID || state.Agent != session.Agent || state.ProjectID != session.ProjectID {
		return nil
	}
	inWindow := func(stamp string) bool {
		at, err := time.Parse(time.RFC3339Nano, stamp)
		return err == nil && !at.Before(from) && !at.After(until)
	}
	var items []keepItem
	if needAsk && inWindow(state.TypedAskAt) && recoverySafe(state.LastAsk) && !rank.Machine(state.LastAsk) {
		items = append(items, keepItem{"Last user request (first line)", state.LastAsk, false})
	}
	if needFailure && state.LastFailure != nil && inWindow(state.FailureAt) && recoverySafe(state.LastFailure.Command) &&
		!strings.HasSuffix(state.LastFailure.Command, "…") {
		items = append(items, keepItem{"Last failing command", state.LastFailure.Command, false})
	}
	return items
}

func labeledQuote(q record.CompactionQuote) keepItem {
	label := "User constraint or correction"
	if q.Kind == "decision" {
		label = "User decision or open choice"
	}
	return keepItem{label, q.Quote, false}
}

func compactionFilter(directory string, session record.Session, from, until time.Time) (record.CompactionFilter, error) {
	for _, name := range []string{"record.db", "record.db-wal", "record.db-shm"} {
		if !safefile.Regular(filepath.Join(directory, name)) {
			return record.CompactionFilter{}, errors.New("redirected capture filter database")
		}
	}
	reader, err := record.OpenRecord(record.Location{Directory: directory, Record: filepath.Join(directory, "record.db")})
	if errors.Is(err, os.ErrNotExist) {
		return record.CompactionFilter{}, nil // no filter store yet
	}
	if err != nil {
		return record.CompactionFilter{}, err
	}
	defer reader.Close()
	return reader.ReadCompactionFilter(session.ProjectID, session.SessionID, from, until)
}

func codeAnchors(text string) []string {
	return strings.FieldsFunc(strings.ToLower(strings.ReplaceAll(text, "\\", "/")), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && !strings.ContainsRune("._/-", r)
	})
}

func compareCompaction(summary string, items []keepItem) ([]keepItem, compactionEstimate) {
	have := map[string]bool{}
	for _, term := range rank.Tokens(summary) {
		have[term] = true
	}
	literal := map[string]bool{}
	for _, word := range codeAnchors(summary) {
		literal[strings.TrimRight(word, ".")] = true
	}
	frequency := map[string]int{}
	terms := make([][]string, len(items))
	for i, item := range items {
		if item.exact {
			continue
		}
		seen := map[string]bool{}
		for _, term := range rank.Tokens(item.text) {
			if !seen[term] {
				seen[term] = true
				terms[i] = append(terms[i], term)
				frequency[term]++
			}
		}
	}
	var missing []keepItem
	out := compactionEstimate{Estimated: true}
	for i, item := range items {
		anchors := terms[i]
		if !item.exact {
			sort.Slice(anchors, func(i, j int) bool {
				left, right := anchors[i], anchors[j]
				if frequency[left] != frequency[right] {
					return frequency[left] < frequency[right]
				}
				if len(left) != len(right) {
					return len(left) > len(right)
				}
				return left < right
			})
			anchors = anchors[:min(4, len(anchors))]
		}
		matched := 0
		for _, a := range anchors {
			if have[a] {
				matched++
			}
		}
		// Allow one changed prose anchor when at least three are available.
		// An edited path, entry ID, or number still needs its literal anchor.
		required := len(anchors)
		if required >= 3 {
			required--
		}
		kept := matched >= required
		checkedLiteral := false
		for _, word := range codeAnchors(item.text) {
			word = strings.TrimRight(word, ".")
			hasNumber := strings.ContainsFunc(word, unicode.IsNumber)
			structured := (strings.ContainsAny(word, "._/") || strings.HasPrefix(word, "--")) &&
				strings.ContainsFunc(word, unicode.IsLetter)
			if word == "" || (!item.exact && !hasNumber && !structured) {
				continue
			}
			checkedLiteral = true
			kept = kept && literal[word]
		}
		if len(anchors) == 0 && !checkedLiteral {
			continue // no anchors to score
		}
		out.Checked++
		if kept {
			out.Kept++
		} else {
			missing = append(missing, item)
		}
	}
	return missing, out
}

func compactionMarker(ev contract.Event, epoch int) string {
	key := strings.Join([]string{ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, strconv.Itoa(epoch)}, "\x00")
	return "[mex " + place.ShortHash("compaction\x00"+key) + "]"
}

func compactionBlock(ev contract.Event, epoch int, missing []keepItem) string {
	out := compactionMarker(ev, epoch) + "\nThe compaction summary may have missed these items. Prefer newer user directions if they conflict:"
	header := out
	for _, item := range missing {
		line := "\n- " + item.label + ": " + strconv.Quote(item.text)
		if entries.EstimateTokens(out+line) <= checkedRecoveryBudget {
			out += line
		}
	}
	if out == header {
		return ""
	}
	return out
}

func checkedRecovery(h *record.Hooks, ev contract.Event, env Environment, epoch int) string {
	cenv := capture.Env{RecordDirectory: env.RecordDirectory, Now: env.Now}
	if env.CaptureDisabled {
		capture.ClearCompactionRecovery(ev, cenv, epoch)
		return ""
	}
	if surfaceSetting(env, ev.ProjectID, "recovery") != "on" {
		return ""
	}
	text := capture.ReadCompactionRecovery(ev, cenv, epoch)
	if text == "" || entries.EstimateTokens(text) > checkedRecoveryBudget {
		return ""
	}
	marker, _, _ := strings.Cut(text, "\n")
	if marker != compactionMarker(ev, epoch) {
		return ""
	}
	session := record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}
	claimed, err := h.ShowOnce(session, "compaction:"+marker, env.Now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return ""
	}
	capture.ClearCompactionRecovery(ev, cenv, epoch)
	if !claimed {
		return ""
	}
	return text
}
