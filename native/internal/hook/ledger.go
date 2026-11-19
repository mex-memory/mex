package hook

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/output"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func leverOff(directory, lever string) bool {
	_, off := ledgerOff(directory, lever)
	return off
}

func ledgerOff(directory, lever string) (int64, bool) {
	if directory == "" {
		return 0, false
	}
	data, err := boundedJudgeRead(filepath.Join(directory, "ledger-off."+lever), 128)
	if err != nil {
		return 0, false
	}
	if string(data) == "1\n" {
		return 0, true
	}
	var gate struct {
		Version   int    `json:"version"`
		Off       bool   `json:"off"`
		RearmedAt *int64 `json:"rearmed_at"`
	}
	if json.Unmarshal(data, &gate) != nil || gate.Version != 1 || gate.RearmedAt == nil ||
		*gate.RearmedAt < 0 || *gate.RearmedAt > 8_640_000_000_000_000 {
		return 0, false
	}
	return *gate.RearmedAt, gate.Off
}

func removedTokens(before, after int) int {
	return max(0, (before+3)/4-(after+3)/4)
}

func observeLever(ev contract.Event, directory string, state *leverState, reply contract.Reply) *localrecord.LeverObservation {
	if ev.AgentID != "" || ev.Tool == nil || ev.SessionID == "" {
		return nil
	}
	tool := ev.Tool
	if ev.Agent == "claude-code" && ev.Kind == contract.PreTool && reply.Decision == contract.Deny {
		return &localrecord.LeverObservation{Lever: localrecord.LeverOutline, Kind: "denial"}
	}
	if ev.Kind != contract.PostTool || tool.Output == nil || !tool.Output.OK {
		return nil
	}
	switch {
	case ev.Agent == "claude-code" && tool.Name == contract.ToolRead:
		mark := state.Outlined[pathKey(tool.Input.Path)]
		if reply.ReplaceOutput == nil && (mark == nil || mark.Context != state.Context || state.Edited[pathKey(tool.Input.Path)]) {
			return nil
		}
		var original readResponse
		if json.Unmarshal([]byte(tool.Output.Text), &original) != nil || original.Type != "text" || original.File.Content == "" {
			return nil
		}
		if reply.ReplaceOutput != nil {
			return &localrecord.LeverObservation{Lever: localrecord.LeverOutline, Kind: "saving",
				TokensRemoved: removedTokens(len(original.File.Content), len(reply.ReplaceOutput.Text))}
		}
		return &localrecord.LeverObservation{Lever: localrecord.LeverOutline, Kind: "refetch"}
	case tool.Name == contract.ToolShell:
		if ev.Agent == "claude-code" && reply.ReplaceOutput != nil {
			return &localrecord.LeverObservation{Lever: localrecord.LeverShellTrim, Kind: "saving",
				TokensRemoved: removedTokens(len(tool.Output.Text), len(reply.ReplaceOutput.Text))}
		}
		if lever := savedOutputRefetch(ev, directory); lever != "" {
			return &localrecord.LeverObservation{Lever: lever, Kind: "refetch"}
		}
	}
	return nil
}

// An explicit mex out of this session's saved output is attributable. A
// repeated build or test command may simply reflect normal work.
func savedOutputRefetch(ev contract.Event, directory string) string {
	command := ev.Tool.Input.Command
	if !strings.HasPrefix(command, "mex out ") || !simpleCommand(command) || ev.ProjectID == "" {
		return ""
	}
	fields := strings.Fields(command)
	if len(fields) < 3 {
		return ""
	}
	n, err := strconv.Atoi(fields[2])
	if err != nil || n <= 0 {
		return ""
	}
	data, err := boundedJudgeRead(filepath.Join(output.Directory(directory, ev.ProjectID), strconv.Itoa(n)+".json"), 16<<10)
	if err != nil {
		return ""
	}
	var meta output.SavedMeta
	if json.Unmarshal(data, &meta) != nil || meta.Version != output.MetaVersion || meta.N != n || meta.SessionID != ev.SessionID {
		return ""
	}
	switch {
	case ev.Agent == "claude-code" && meta.Agent == "claude-code":
		return localrecord.LeverShellTrim
	case ev.Agent == "codex" && meta.Agent == "mex run":
		return localrecord.LeverWrapper
	}
	return ""
}

func recordLeverObservation(ev contract.Event, h home, directory string, at time.Time, elapsed time.Duration, observation localrecord.LeverObservation) {
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return
	}
	defer hooks.Close()
	key := at.UTC().Format(time.RFC3339Nano)
	if ev.Tool != nil && ev.Tool.UseID != "" {
		key = ev.Tool.UseID
	}
	observation.HookMS = (elapsed + time.Millisecond - 1).Milliseconds()
	_ = hooks.RecordLeverObservation(hookSession(ev), key, at, observation)
}

func hookSession(ev contract.Event) localrecord.Session {
	return localrecord.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}
}

type ledgerPersonNotice struct{ id, text string }

func ledgerNotice(ev contract.Event, h home, directory string, now time.Time) string {
	if directory == "" || ev.Kind != contract.SessionStart || ev.AgentID != "" || ev.SessionID == "" || capture.Scripted(ev.Agent, h.env) {
		return ""
	}
	var levers []string
	switch ev.Agent {
	case "claude-code":
		levers = []string{localrecord.LeverOutline, localrecord.LeverShellTrim}
	case "codex":
		levers = []string{localrecord.LeverWrapper}
	default:
		return ""
	}
	names := map[string]string{localrecord.LeverOutline: "file outlines", localrecord.LeverShellTrim: "shell output trimming",
		localrecord.LeverWrapper: "the Codex output wrapper"}
	var pending []ledgerPersonNotice
	for _, lever := range levers {
		rearmed, off := ledgerOff(directory, lever)
		trial := strconv.FormatInt(rearmed, 10)
		key := lever
		if rearmed != 0 {
			key += "." + trial
		}
		if off {
			pending = append(pending, ledgerPersonNotice{"ledger.off." + key,
				"MEX turned off " + names[lever] + " after the last 10 measured sessions had zero or negative estimated savings. Run `mex on --lever " + lever + "` to turn it back on."})
			continue
		}
		report, err := boundedJudgeRead(filepath.Join(directory, "ledger-report."+lever), 24)
		if err == nil && string(report) == trial {
			pending = append(pending, ledgerPersonNotice{"ledger.report." + key,
				"MEX's priced ledger estimated zero or negative savings for " + names[lever] + " over the last 10 measured sessions. Ledger auto-off is in report-only mode."})
		}
	}
	pending = append(pending, compactionLedgerNotices(ev, directory)...)
	if len(pending) == 0 {
		return ""
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return ""
	}
	defer hooks.Close()
	var notices []string
	for _, notice := range pending {
		if shown, err := hooks.NoticeShown(notice.id); err != nil || shown {
			continue
		}
		if first, err := hooks.ShowOnce(hookSession(ev), notice.id, now.UTC().Format(time.RFC3339Nano)); err == nil && first && !slices.Contains(notices, notice.text) {
			notices = append(notices, notice.text)
		}
	}
	return strings.Join(notices, "\n")
}

func compactionLedgerNotices(ev contract.Event, directory string) []ledgerPersonNotice {
	if ev.Checkout == "" {
		return nil
	}
	var notices []ledgerPersonNotice
	for _, scope := range []string{"user", place.ShortHash(ev.Checkout)} {
		path := filepath.Join(directory, "ledger-compaction."+ev.Agent+"."+scope)
		data, err := boundedJudgeRead(path, 32)
		id, report := strings.CutPrefix(string(data), "report:")
		if err != nil || len(id) != 24 {
			continue
		}
		if _, err := hex.DecodeString(id); err != nil {
			continue
		}
		if report {
			notices = append(notices, ledgerPersonNotice{"ledger.report.compaction." + id,
				"MEX's priced ledger estimated zero or negative savings for an accepted compaction setting. Ledger rollback is in report-only mode."})
		} else {
			notices = append(notices, ledgerPersonNotice{"ledger.off.compaction." + id,
				"MEX restored the previous compaction setting after its estimated token savings fell to zero or below."})
		}
	}
	return notices
}

type ledgerSettlement struct {
	Agent    string                   `json:"agent"`
	Session  string                   `json:"session"`
	Project  string                   `json:"project"`
	Checkout string                   `json:"checkout"`
	Ended    time.Time                `json:"ended"`
	Profile  string                   `json:"price_profile"`
	Terms    []localrecord.LedgerTerm `json:"terms"`
}

// The background worker does the transcript scan. This command owns the
// transaction in Go and accepts only an existing checkout-scoped session.
func settleLedger(stdin io.Reader, stdout io.Writer, getenv Env) int {
	var input ledgerSettlement
	decoder := json.NewDecoder(io.LimitReader(stdin, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || len(input.Terms) > localrecord.MaxLedgerTerms {
		return 1
	}
	h := homeFrom(getenv)
	directory := h.recordDirectory()
	checkout, state := findCheckout(directory, input.Checkout, false, time.Now())
	if state == unregistered || checkout.Root != input.Checkout || checkout.ProjectID != input.Project {
		return 1
	}
	global := h.controls()
	if state != switchedOn || global.Off || !captureEnabled(directory, input.Project, global) {
		_, _ = io.WriteString(stdout, "{\"saved\":false}\n")
		return 0
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return 1
	}
	defer hooks.Close()
	saved, err := hooks.SettleLedger(localrecord.Session{SessionID: input.Session, Agent: input.Agent,
		ProjectID: input.Project, Checkout: input.Checkout}, input.Ended, input.Profile, input.Terms)
	if err != nil {
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "{\"saved\":%t}\n", saved)
	return 0
}
