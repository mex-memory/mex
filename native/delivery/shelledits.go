package delivery

import (
	"context"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
)

const (
	maxShellChanged = 32
	// The scan deadline covers index range queries and file stats.
	shellScanBudget = 18 * time.Millisecond
	// Git runs only after a command changed indexed code. On a 10,000-file
	// Windows checkout one diff took 160-170 ms, nearly all process startup;
	// leave room for a busy machine, under one deadline for all Git reads.
	shellDiffBudget = 500 * time.Millisecond
)

// shellEdits runs once for the event's checkout, even with several shell
// commands in a batch. Hunks use today's line numbers.
func shellEdits(ev contract.Event, env Environment) (ChangedLines, map[string]int64, bool) {
	if ev.ProjectID == "" || ev.Checkout == "" {
		return nil, nil, true
	}
	targets, write, bounded := shellTargets(ev)
	if !write || !bounded {
		return nil, nil, bounded
	}
	session := map[string]bool{}
	observed := map[string]int64{}
	for file := range env.Changed {
		if rel, ok := shellRelative(ev.Checkout, file); ok && rel != "." {
			session[rel] = true
		}
	}
	for file, mtime := range env.ShellMtimes {
		if rel, ok := shellRelative(ev.Checkout, file); ok && rel != "." {
			observed[rel] = mtime
			session[rel] = true
		}
	}
	if len(targets)+len(session) == 0 {
		return nil, nil, true
	}
	ix := openRescueIndex(env, ev)
	if ix == nil {
		return nil, nil, false
	}
	defer closeRescueIndex(env, ix)
	ctx, cancel := context.WithTimeout(context.Background(), shellScanBudget)
	files, complete := ix.RecentlyChangedCode(ctx, targets, slices.Collect(maps.Keys(session)), env.Now.Add(-shellCatchWindow), env.Now, maxShellChanged, observed)
	cancel()
	if len(files) == 0 {
		return nil, nil, complete
	}
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, file.Path)
	}
	ctx, cancel = context.WithTimeout(context.Background(), shellDiffBudget)
	defer cancel()
	patch, whole, ok := capture.WorktreePatch(ctx, ev.Checkout, paths)
	if !ok || ctx.Err() != nil {
		return nil, nil, false
	}
	edits, ok := diffSpans(patch)
	if !ok {
		return nil, nil, false
	}
	for _, rel := range whole {
		edits[rel] = wholeFile()
	}
	mtimes := map[string]int64{}
	for _, file := range files {
		full := filepath.Join(ev.Checkout, filepath.FromSlash(file.Path))
		info, err := os.Lstat(full)
		if err != nil || !info.Mode().IsRegular() || info.ModTime().UnixNano() != file.Mtime {
			return nil, nil, false // the worktree moved while Git read it
		}
		mtimes[full] = file.Mtime
	}
	return edits, mtimes, true
}

func wholeFile() []LineSpan {
	return []LineSpan{{From: 1, To: math.MaxInt32}}
}

func shellLineChanges(checkout string, edits ChangedLines) ChangedLines {
	changed := ChangedLines{}
	for rel, spans := range edits {
		today := make([]LineSpan, 0, len(spans))
		for _, span := range spans {
			// A deletion has no new lines. Keep its location for tests.
			span.To = max(span.From, span.To)
			today = append(today, span)
		}
		changed[filepath.Join(checkout, filepath.FromSlash(rel))] = today
	}
	return changed
}

// diffSpans reads the new-file side of each hunk. A zero-length range
// denotes the gap between lines, so deleting the first body line doesn't
// count as touching the signature above it.
func diffSpans(patch string) (ChangedLines, bool) {
	changed := ChangedLines{}
	var rel string
	var newFile, inHunk bool
	for line := range strings.SplitSeq(patch, "\n") {
		line = strings.TrimSuffix(line, "\r")
		switch {
		case strings.HasPrefix(line, "diff --git "):
			rel, newFile, inHunk = "", false, false
		case !inHunk && line == "--- /dev/null":
			newFile = true
		case !inHunk && strings.HasPrefix(line, "+++ "):
			if line == "+++ /dev/null" {
				continue
			}
			var ok bool
			rel, ok = diffPath(line[4:])
			if !ok {
				return nil, false
			}
			if newFile {
				changed[rel] = wholeFile()
			}
		case strings.HasPrefix(line, "@@ "):
			inHunk = true
			span, ok := diffHunkSpan(line)
			if !ok {
				return nil, false
			}
			if rel != "" && !newFile {
				changed[rel] = append(changed[rel], span)
			}
		}
	}
	return changed, true
}

func diffPath(text string) (string, bool) {
	name := strings.TrimSuffix(text, "\t")
	if strings.HasPrefix(name, `"`) {
		var err error
		name, err = strconv.Unquote(name)
		if err != nil {
			return "", false
		}
	}
	rel, ok := strings.CutPrefix(name, "b/")
	return rel, ok && filepath.IsLocal(filepath.FromSlash(rel))
}

func diffHunkSpan(line string) (LineSpan, bool) {
	_, rest, ok := strings.Cut(line, " +")
	coords, tail, ended := strings.Cut(rest, " ")
	if !ok || !ended || !strings.HasPrefix(tail, "@@") {
		return LineSpan{}, false
	}
	start, length, counted := strings.Cut(coords, ",")
	if !counted {
		length = "1"
	}
	a, startErr := strconv.ParseUint(start, 10, 31)
	b, lengthErr := strconv.ParseUint(length, 10, 31)
	if startErr != nil || lengthErr != nil || a+b > math.MaxInt32 || (a == 0 && b != 0) {
		return LineSpan{}, false
	}
	if b == 0 {
		return LineSpan{From: int(a) + 1, To: int(a)}, true
	}
	return LineSpan{From: int(a), To: int(a + b - 1)}, true
}
