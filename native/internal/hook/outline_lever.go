package hook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/tokens"
	"github.com/mex-memory/mex/native/outline"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Big file reads (L2, Claude Code only). A read with no range of a file over
// 10k calibrated tokens (about 23k bytes), not edited in this session and not
// named in the prompt, is shown as its outline from the file index plus the slices the prompt names. The
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

// countOutline runs inside the session's immediate transaction.
func (state *leverState) countOutline(outlines, trips int, now time.Time) bool {
	s := state.guard
	if s == nil || s.Off {
		return false
	}
	s.Outlines += outlines
	s.Trips += trips
	if s.Outlines >= killAfter && float64(s.Trips) > killShare*float64(s.Outlines) {
		s.Off = true
		s.OffSince = now.UTC().Format(time.RFC3339)
		return true
	}
	return false
}
func killSwitchLine(_ string) string {
	return "MEX stopped showing big files as outlines: the agent needed the full text too often. Run `mex on --lever outline` to turn outlines back on."
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
	var resp readResponse
	if json.Unmarshal([]byte(ev.Tool.Output.Text), &resp) != nil {
		return contract.Reply{}, false
	}
	if current && !mark.Full && resp.Type != "text" && !h.levers.raw && !h.levers.noOutline {
		return recoverRead(ev, state, mark)
	}
	if ev.Tool.Input.Offset != nil || ev.Tool.Input.Limit != nil {
		if current && resp.Type == "text" {
			mark.Ranged = true
			if resp.File.StartLine <= 1 && resp.File.NumLines >= mark.Lines {
				mark.Full = true
			}
			return contract.Reply{}, true
		}
		return contract.Reply{}, false
	}
	if current && resp.Type == "text" {
		mark.Ranged = true
		mark.Full = resp.File.StartLine <= 1 && resp.File.NumLines >= mark.Lines
		return contract.Reply{}, true
	}
	if current || h.levers.raw || h.levers.noOutline || state.Edited[key] || ev.ProjectID == "" || ev.Checkout == "" {
		return contract.Reply{}, false
	}
	if resp.Type != "text" || resp.File.StartLine > 1 || resp.File.NumLines <= 0 {
		return contract.Reply{}, false
	}
	if tokens.Code(resp.File.Content) <= outline.MinTokens || namedIn(state.Words, path) {
		return contract.Reply{}, false
	}
	if (state.guard != nil && state.guard.Off) || leverOff(recordDirectory, localrecord.LeverOutline) {
		return contract.Reply{}, false
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxOutlineFile {
		return contract.Reply{}, false
	}
	data, err := boundedOutlineRead(path)
	if err != nil {
		return contract.Reply{}, false
	}
	if returnedReadText(resp.File.Content, resp.File.NumLines) != returnedReadText(string(data), resp.File.NumLines) {
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
	res, ok := outline.Render(outline.Input{TotalLines: resp.File.TotalLines, Path: rel, Content: returnedReadText(resp.File.Content, resp.File.NumLines), Symbols: answer.Symbols, Dropped: answer.Dropped, Terms: terms})
	if !ok {
		return contract.Reply{}, false
	}
	if state.Outlined == nil {
		state.Outlined = map[string]*outlineMark{}
	}
	if state.guard == nil || state.guard.StoreOriginal == nil || state.guard.StoreOriginal(key, state.Context, resp.File.Content) != nil {
		return contract.Reply{}, false
	}
	state.Outlined[key] = &outlineMark{Context: state.Context, Lines: min(res.Lines, resp.File.NumLines), Hash: hex.EncodeToString(sum[:])}
	reply := contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: res.Text, OK: true}}
	if state.countOutline(1, 0, now) {
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
	if t.Input.Path == "" || h.levers.raw || h.levers.noOutline {
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
		// the text again rather than a note that the file is unchanged. The
		// path is left as the agent wrote it, not as MEX normalized it.
		offset, limit := 1, mark.Lines
		trip := !mark.Forced
		mark.Forced = true
		reply := contract.Reply{ReplaceInput: &contract.ToolInput{Offset: &offset, Limit: &limit}}
		if trip && state.countOutline(0, 1, time.Now()) {
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
		reason := fmt.Sprintf("MEX showed %s as an outline, not its text, so this %s was stopped once. Read the lines you are changing first (Read with offset and limit, or offset=1 limit=%d for the original read), then %s it.", filepath.Base(t.Input.Path), verb, mark.Lines, verb)
		reply := contract.Reply{Decision: contract.Deny, Reason: reason}
		if state.countOutline(0, 1, time.Now()) {
			reply.PersonLine = killSwitchLine(recordDirectory)
		}
		return reply, true
	}
	return contract.Reply{}, false
}

// A host unchanged stub cannot refer back to text that the model never saw.
func recoverRead(ev contract.Event, state *leverState, mark *outlineMark) (contract.Reply, bool) {
	limit := mark.Lines
	fallback := contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: fmt.Sprintf("MEX previously showed an outline. Read this file with offset=1 limit=%d to receive its text.", max(1, limit)), OK: true}}
	if limit <= 0 || mark.Hash == "" || state.Edited[pathKey(ev.Tool.Input.Path)] {
		return fallback, false
	}
	data, err := boundedOutlineRead(ev.Tool.Input.Path)
	if err != nil || !utf8.Valid(data) {
		return fallback, false
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != mark.Hash {
		return fallback, false
	}
	lines := strings.SplitAfter(string(data), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	text := strings.Join(lines[:min(limit, len(lines))], "")
	mark.Full, mark.Ranged = true, true
	return contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: text, OK: true, ReadTotalLines: len(lines)}}, true
}
func boundedOutlineRead(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > maxOutlineFile {
		return nil, fmt.Errorf("read limit")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(before, after) {
		return nil, fmt.Errorf("file changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxOutlineFile+1))
	if len(data) > maxOutlineFile {
		return nil, fmt.Errorf("read limit")
	}
	return data, err
}

// returnedReadText is the first limit lines of text as the host returns a
// read: the host drops a leading byte-order mark and shows CRLF line endings
// as LF, so a checkout with CRLF files still matches its own read.
func returnedReadText(text string, limit int) string {
	text = strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n")
	lines := strings.SplitAfter(text, "\n")
	return strings.Join(lines[:min(len(lines), max(0, limit))], "")
}
