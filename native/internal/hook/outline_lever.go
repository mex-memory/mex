package hook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/outline"
	"github.com/mex-memory/mex/native/record/place"
)

// Big file reads (L2, Claude Code only). A read with no range of a file over
// 6k tokens, not edited in this session and not named in the prompt, is shown
// as its outline from the file index plus the slices the prompt names. The
// rules from the plan's T1 test keep the agent from being locked out:
//
//   - a file is outlined at most once per context;
//   - the first edit or full write of an outlined file is stopped once, until
//     the agent reads the lines it changes;
//   - the next full read of an outlined file is turned into an explicit
//     range, so the agent gets the text and not an "unchanged" stub.
//
// A kill switch turns outlines off on this machine when the guards trip often.

const (
	// Kill switch: after killAfter outlines, outlines stop when more than
	// killShare of them made a guard trip. Starting values; tuned by the
	// model test (delivery-04-T1).
	killAfter = 10
	killShare = 0.5
	// maxOutlineFile: bigger files are not read for hashing on the hook path.
	maxOutlineFile = 4 << 20
)

type outlineStats struct {
	Version  int    `json:"version"`
	Outlines int    `json:"outlines"`
	Trips    int    `json:"trips"`
	Off      bool   `json:"off,omitempty"`
	OffSince string `json:"off_since,omitempty"`
}

func outlineStatsPath(recordDirectory string) string {
	return filepath.Join(recordDirectory, "levers", "outlines.json")
}

func readOutlineStats(recordDirectory string) outlineStats {
	var s outlineStats
	if data, err := os.ReadFile(outlineStatsPath(recordDirectory)); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

// countOutline records an outline or a guard trip, and reports whether this
// call turned the kill switch on.
func countOutline(recordDirectory string, outlines, trips int, now time.Time) bool {
	s := readOutlineStats(recordDirectory)
	if s.Off {
		return false
	}
	s.Version = 1
	s.Outlines += outlines
	s.Trips += trips
	switched := s.Outlines >= killAfter && float64(s.Trips) > killShare*float64(s.Outlines)
	if switched {
		s.Off, s.OffSince = true, now.UTC().Format(time.RFC3339)
	}
	data, err := json.Marshal(s)
	file := outlineStatsPath(recordDirectory)
	if err != nil || os.MkdirAll(filepath.Dir(file), 0o700) != nil {
		return false
	}
	tmp := file + "." + randomSuffix() + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return false
	}
	if os.Rename(tmp, file) != nil {
		_ = os.Remove(tmp)
		return false
	}
	return switched
}

func killSwitchLine(recordDirectory string) string {
	return fmt.Sprintf("MEX stopped showing big files as outlines: the agent needed the full text too often. Delete %s to turn outlines back on.", outlineStatsPath(recordDirectory))
}

// readResponse is Claude Code's Read result for a text file.
type readResponse struct {
	Type string `json:"type"`
	File struct {
		FilePath   string `json:"filePath"`
		Content    string `json:"content"`
		NumLines   int    `json:"numLines"`
		StartLine  int    `json:"startLine"`
		TotalLines int    `json:"totalLines"`
	} `json:"file"`
}

// outlineRead runs after a successful Read.
func outlineRead(ev contract.Event, h home, recordDirectory string, state *leverState, now time.Time) (contract.Reply, bool) {
	path := ev.Tool.Input.Path
	if path == "" {
		return contract.Reply{}, false
	}
	key := pathKey(path)
	mark := state.Outlined[key]
	current := mark != nil && mark.Context == state.Context
	if ev.Tool.Input.Offset != nil || ev.Tool.Input.Limit != nil {
		// A ranged read of an outlined file: the agent has its text now.
		if current && !mark.Ranged {
			mark.Ranged = true
			return contract.Reply{}, true
		}
		return contract.Reply{}, false
	}
	if current || h.levers.raw || h.levers.noOutline || state.Edited[key] || ev.ProjectID == "" || ev.Checkout == "" {
		return contract.Reply{}, false
	}
	var resp readResponse
	if json.Unmarshal([]byte(ev.Tool.Output.Text), &resp) != nil || resp.Type != "text" || resp.File.StartLine > 1 {
		return contract.Reply{}, false
	}
	if len(resp.File.Content)/4 <= outline.MinTokens || namedIn(state.Words, path) {
		return contract.Reply{}, false
	}
	if readOutlineStats(recordDirectory).Off {
		return contract.Reply{}, false
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxOutlineFile {
		return contract.Reply{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return contract.Reply{}, false
	}
	sum := sha256.Sum256(data)
	reader, err := index.Open(recordDirectory, ev.ProjectID, ev.Checkout)
	if err != nil {
		return contract.Reply{}, false
	}
	defer reader.Close()
	if !reader.Exact(path, hex.EncodeToString(sum[:])[:32]) {
		return contract.Reply{}, false
	}
	answer, miss := reader.Outline(path)
	if miss != nil {
		return contract.Reply{}, false
	}
	terms := map[uint64]bool{}
	for _, w := range state.Words {
		terms[w] = true
	}
	rel := answer.Path
	if rel == "" {
		if r, ok := place.RelativeToCheckout(ev.Checkout, path); ok {
			rel = r
		} else {
			rel = filepath.Base(path)
		}
	}
	res, ok := outline.Render(outline.Input{Path: rel, Content: string(data), Symbols: answer.Symbols, Dropped: answer.Dropped, Terms: terms})
	if !ok {
		return contract.Reply{}, false
	}
	if state.Outlined == nil {
		state.Outlined = map[string]*outlineMark{}
	}
	state.Outlined[key] = &outlineMark{Context: state.Context, Lines: res.Lines}
	reply := contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: res.Text, OK: true}}
	if countOutline(recordDirectory, 1, 0, now) {
		reply.PersonLine = killSwitchLine(recordDirectory)
	}
	return reply, true
}

// namedIn reports whether the prompt named the file: its base name, or its
// stem when that is at least three letters long.
func namedIn(words []uint64, path string) bool {
	if len(words) == 0 {
		return false
	}
	base := filepath.Base(strings.ReplaceAll(path, `\`, "/"))
	names := []string{base}
	if dot := strings.LastIndex(base, "."); dot >= 3 {
		names = append(names, base[:dot])
	}
	for _, n := range names {
		h := wordHash(n)
		for _, w := range words {
			if w == h {
				return true
			}
		}
	}
	return false
}

// outlineGuard runs before Read, Edit and Write on Claude Code.
func outlineGuard(ev contract.Event, h home, recordDirectory string, state *leverState) (contract.Reply, bool) {
	t := ev.Tool
	if t.Input.Path == "" {
		return contract.Reply{}, false
	}
	mark := state.Outlined[pathKey(t.Input.Path)]
	if mark == nil || mark.Context != state.Context {
		return contract.Reply{}, false
	}
	switch t.Name {
	case contract.ToolRead:
		if t.Input.Offset != nil || t.Input.Limit != nil || mark.Lines <= 0 {
			return contract.Reply{}, false
		}
		// The next full read gets an explicit range, so the agent receives
		// the text again rather than a note that the file is unchanged.
		offset, limit := 1, mark.Lines
		trip := !mark.Forced
		mark.Forced, mark.Ranged = true, true
		reply := contract.Reply{ReplaceInput: &contract.ToolInput{Path: t.Input.Path, Offset: &offset, Limit: &limit}}
		if trip && countOutline(recordDirectory, 0, 1, time.Now()) {
			reply.PersonLine = killSwitchLine(recordDirectory)
		}
		return reply, true
	case contract.ToolEdit, contract.ToolWrite:
		if mark.Ranged || mark.Stopped {
			return contract.Reply{}, false
		}
		mark.Stopped = true
		verb := "edit"
		if t.Name == contract.ToolWrite {
			verb = "rewrite"
		}
		reason := fmt.Sprintf("MEX showed %s as an outline, not its text, so this %s was stopped once. Read the lines you are changing first (Read with offset and limit, or offset=1 limit=%d for the whole file), then %s it.", filepath.Base(t.Input.Path), verb, mark.Lines, verb)
		reply := contract.Reply{Decision: contract.Deny, Reason: reason}
		if countOutline(recordDirectory, 0, 1, time.Now()) {
			reply.PersonLine = killSwitchLine(recordDirectory)
		}
		return reply, true
	}
	return contract.Reply{}, false
}
