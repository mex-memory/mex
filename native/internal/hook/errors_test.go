package hook

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHookErrorsAreBoundedAndRedacted(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)
	for i := range hookErrorsKept + 5 {
		noteHookError(dir, "claude-code", "Stop", errDelivery, fmt.Sprintf("failure %d %s", i, strings.Repeat("x", 500)), now.Add(time.Duration(i)*time.Second))
	}
	noteHookError(dir, "codex", "PreToolUse", errPanic, "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", now.Add(time.Hour))
	e := loadHookErrors(hookErrorsPath(dir))
	if e.Counts[errDelivery] != hookErrorsKept+5 || e.Counts[errPanic] != 1 || len(e.Recent) != hookErrorsKept {
		t.Fatalf("counts %v, kept %d", e.Counts, len(e.Recent))
	}
	if e.First != now.Format(time.RFC3339Nano) {
		t.Fatalf("first error time lost: %q", e.First)
	}
	last := e.Recent[len(e.Recent)-1]
	if strings.Contains(last.Detail, "ghp_abcdefghijklmnopqrstuvwxyz0123456789") || last.Kind != errPanic || last.Agent != "codex" {
		t.Fatalf("last error: %+v", last)
	}
	for _, r := range e.Recent {
		if len(r.Detail) > hookErrorDetail {
			t.Fatalf("detail not cut: %d bytes", len(r.Detail))
		}
	}
}

func TestHookErrorsNeverCreateStorage(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-mex")
	noteHookError(missing, "claude-code", "Stop", errPanic, "boom", time.Now())
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("created MEX storage: %v", err)
	}
	noteHookError("", "claude-code", "Stop", errPanic, "boom", time.Now())
}

func TestErrorKind(t *testing.T) {
	for err, want := range map[error]string{
		context.DeadlineExceeded:                           errBusy,
		fmt.Errorf("read: %w", context.DeadlineExceeded):   errBusy,
		errors.New("database is locked (5) (SQLITE_BUSY)"): errBusy,
		errors.New("redirected hooks database"):            errDelivery,
		errors.New("the server is busy rendering"):         errDelivery,
	} {
		if got := errorKind(err); got != want {
			t.Errorf("errorKind(%q) = %s, want %s", err, got, want)
		}
	}
}

func TestErrorsNoticeOncePerNewErrors(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.Local)
	if line, _ := errorsNotice(dir, now); line != "" {
		t.Fatalf("no errors, but: %q", line)
	}
	// Busy errors alone are never announced.
	noteHookError(dir, "claude-code", "Stop", errBusy, "database is locked", now.Add(-time.Hour))
	if line, _ := errorsNotice(dir, now); line != "" {
		t.Fatalf("busy announced: %q", line)
	}
	noteHookError(dir, "claude-code", "Stop", errDelivery, "boom", now.Add(-26*time.Hour))
	noteHookError(dir, "codex", "Stop", errPanic, "boom", now.Add(-time.Hour))
	line, mark := errorsNotice(dir, now)
	if line != "MEX · 2 hook errors yesterday, your agent kept working · `mex doctor`" {
		t.Fatalf("line: %q", line)
	}
	markErrorsShown(dir, mark)
	if line, _ := errorsNotice(dir, now.Add(time.Minute)); line != "" {
		t.Fatalf("shown twice: %q", line)
	}
	// A new error after the line ran is announced on its own.
	noteHookError(dir, "codex", "Stop", errParse, "bad json", now.Add(2*time.Minute))
	if line, _ := errorsNotice(dir, now.Add(3*time.Minute)); line != "MEX · 1 hook error today, your agent kept working · `mex doctor`" {
		t.Fatalf("line: %q", line)
	}
	// Older errors read "since <date>".
	old := t.TempDir()
	noteHookError(old, "codex", "Stop", errPanic, "boom", now.AddDate(0, 0, -5))
	if line, _ := errorsNotice(old, now); !strings.Contains(line, "1 hook error since 20 Nov") {
		t.Fatalf("line: %q", line)
	}
}

func TestHookErrorsIgnoreAForeignFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(hookErrorsPath(dir), []byte(`{"version":99,"recent":[{"at":"2026-11-25T00:00:00Z","kind":"panic"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if line, _ := errorsNotice(dir, time.Now()); line != "" {
		t.Fatalf("read an unknown version: %q", line)
	}
	noteHookError(dir, "codex", "Stop", errPanic, "boom", time.Now())
	if e := loadHookErrors(hookErrorsPath(dir)); e.Version != hookErrorsVersion || e.Counts[errPanic] != 1 {
		t.Fatalf("%+v", e)
	}
}
