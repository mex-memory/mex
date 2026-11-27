package hook

// Calm errors (plan sheet 46): the shim always exits 0 with the agent's own
// "do nothing" reply, so an error never stops the agent. What went wrong is
// kept in a small file in the local record, one line at the next session
// start points to `mex doctor`, and `mex doctor` lists them.
//
// The file is written without SQLite, so it works on the crash path and
// when hooks.db is the problem. It is bounded: counts by kind and the last
// errors, details redacted and cut short. Two hooks failing at once can lose
// one update; the counts are a signal, not a ledger.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/capture"
)

const (
	hookErrorsFile    = "hook-errors.json"
	hookErrorsVersion = 1
	// hookErrorsKept bounds the errors kept with their details.
	hookErrorsKept = 20
	// hookErrorDetail bounds one error's detail, in bytes.
	hookErrorDetail = 240
	// hookErrorsBytes bounds the file a reader accepts.
	hookErrorsBytes = 64 << 10
)

// Error kinds. Busy is expected under contention (a locked database, a
// missed deadline): kept for `mex doctor`, never announced.
const (
	errPanic    = "panic"
	errParse    = "parse"
	errDelivery = "delivery"
	errBusy     = "busy"
)

type hookError struct {
	At     string `json:"at"`
	Agent  string `json:"agent"`
	Event  string `json:"event"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// hookErrors is the file's shape (local record contract, hook-errors.json).
type hookErrors struct {
	Version int            `json:"version"`
	Counts  map[string]int `json:"counts"`
	First   string         `json:"first"`
	// ShownAt is when the session-start line last named the errors; errors
	// after it are new.
	ShownAt string      `json:"shown_at,omitempty"`
	Recent  []hookError `json:"recent"`
}

func hookErrorsPath(recordDirectory string) string {
	return filepath.Join(recordDirectory, hookErrorsFile)
}

func loadHookErrors(file string) hookErrors {
	var e hookErrors
	if info, err := os.Stat(file); err == nil && info.Mode().IsRegular() && info.Size() <= hookErrorsBytes {
		if data, err := os.ReadFile(file); err == nil {
			_ = json.Unmarshal(data, &e)
		}
	}
	if e.Version != hookErrorsVersion || e.Counts == nil {
		e = hookErrors{Version: hookErrorsVersion, Counts: map[string]int{}}
	}
	return e
}

func (e hookErrors) save(file string) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// errorKind sorts a delivery error: contention is busy, the rest delivery.
func errorKind(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return errBusy
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "database is locked") || strings.Contains(text, "sqlite_busy") || strings.Contains(text, "database table is locked") {
		return errBusy
	}
	return errDelivery
}

// noteHookError records one error. It never creates MEX's storage: with no
// record folder there is nothing to write to. It never fails the hook.
func noteHookError(recordDirectory, agent, event, kind, detail string, now time.Time) {
	defer func() { _ = recover() }()
	if recordDirectory == "" {
		return
	}
	if info, err := os.Stat(recordDirectory); err != nil || !info.IsDir() {
		return
	}
	file := hookErrorsPath(recordDirectory)
	e := loadHookErrors(file)
	at := now.UTC().Format(time.RFC3339Nano)
	if e.First == "" {
		e.First = at
	}
	e.Counts[kind]++
	e.Recent = append(e.Recent, hookError{At: at, Agent: clipText(agent, 32), Event: clipText(event, 64), Kind: kind, Detail: clipText(capture.Redact(detail), hookErrorDetail)})
	if over := len(e.Recent) - hookErrorsKept; over > 0 {
		e.Recent = e.Recent[over:]
	}
	_ = e.save(file)
}

func clipText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// errorsNotice is the session-start line for errors since the line last
// ran, busy ones aside, with the time to mark once the line is shown.
func errorsNotice(recordDirectory string, now time.Time) (line, mark string) {
	if recordDirectory == "" {
		return "", ""
	}
	e := loadHookErrors(hookErrorsPath(recordDirectory))
	shown, _ := time.Parse(time.RFC3339Nano, e.ShownAt)
	count := 0
	var first time.Time
	for _, r := range e.Recent {
		at, err := time.Parse(time.RFC3339Nano, r.At)
		if err != nil || r.Kind == errBusy || !at.After(shown) {
			continue
		}
		count++
		if first.IsZero() || at.Before(first) {
			first = at
		}
	}
	if count == 0 {
		return "", ""
	}
	when := "since " + first.Local().Format("2 Jan")
	if y, m, d := first.Local().Date(); y == now.Local().Year() && m == now.Local().Month() && d == now.Local().Day() {
		when = "today"
	} else if y, m, d := first.Local().Date(); now.Local().AddDate(0, 0, -1).Format("2006-01-02") == fmt.Sprintf("%04d-%02d-%02d", y, m, d) {
		when = "yesterday"
	}
	noun := "hook errors"
	if count == 1 {
		noun = "hook error"
	}
	return fmt.Sprintf("MEX · %d %s %s, your agent kept working · `mex doctor`", count, noun, when), now.UTC().Format(time.RFC3339Nano)
}

// markErrorsShown records that the line named every error up to mark.
func markErrorsShown(recordDirectory, mark string) {
	defer func() { _ = recover() }()
	file := hookErrorsPath(recordDirectory)
	if _, err := os.Stat(file); err != nil {
		return
	}
	e := loadHookErrors(file)
	e.ShownAt = mark
	_ = e.save(file)
}

// notePanic records a recovered panic. It resolves the record folder itself,
// since the panic may have come before anything else did, and never panics.
func notePanic(getenv Env, agent, event string, r any) {
	defer func() { _ = recover() }()
	noteHookError(homeFrom(getenv).recordDirectory(), agent, event, errPanic, fmt.Sprint(r), time.Now())
}
