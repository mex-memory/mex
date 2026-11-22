package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

type explicitProbeInput struct {
	Entry, Kind, Session, Project, Checkout string
	Level, Action, Invocation               string
}

func explicitProbe(stdin io.Reader, stdout io.Writer, getenv Env) int {
	var in explicitProbeInput
	if json.NewDecoder(io.LimitReader(stdin, 16384)).Decode(&in) != nil || (in.Kind != "opened" && in.Kind != "wrong" && in.Kind != "recall") {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	directory := homeFrom(getenv).recordDirectory()
	file := filepath.Join(directory, "hooks.db")
	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safeTelemetryFile(filepath.Join(directory, name)) {
			_, _ = io.WriteString(stdout, "{}\n")
			return 0
		}
	}
	if _, err := os.Stat(file); err != nil {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	h, err := localrecord.OpenHooks(localrecord.Location{Directory: directory, Hooks: file})
	if err != nil {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	defer h.Close()
	if in.Kind == "recall" {
		_ = json.NewEncoder(stdout).Encode(map[string]bool{"ok": recallReceipt(h, in)})
		return 0
	}
	ok, err := h.ExplicitProbe(in.Entry, in.Kind, in.Session, in.Project, in.Checkout)
	_ = json.NewEncoder(stdout).Encode(map[string]bool{"ok": ok && err == nil})
	return 0
}

func recallReceipt(h *localrecord.Hooks, in explicitProbeInput) bool {
	if len(in.Invocation) != 36 || len(in.Entry) > 67 || !strings.HasPrefix(in.Entry, "mx_") ||
		(in.Level != "team" && in.Level != "personal") ||
		(in.Action != "given" && in.Action != "replaced" && in.Action != "withheld") {
		return false
	}
	for _, c := range in.Invocation {
		if !strings.ContainsRune("0123456789abcdef-", c) {
			return false
		}
	}
	checkout, err := place.RealPath(in.Checkout)
	if err != nil {
		return false
	}
	attributed := false
	session := localrecord.Session{SessionID: "mex:recall:" + in.Invocation, Agent: "cli", ProjectID: in.Project, Checkout: checkout}
	var expected *int
	if in.Session != "" {
		prior, err := h.Session(in.Session)
		if err == nil && prior != nil && !prior.Paused && prior.ProjectID == in.Project && prior.Checkout == checkout {
			epoch, found, err := h.CurrentEpoch(in.Session, "")
			if err == nil && found && !epoch.Closed {
				session, expected, attributed = *prior, &epoch.Number, true
			}
		}
	}
	form := "full"
	if in.Action != "given" {
		form = "pointer"
	}
	result, err := h.CheckAndMark(localrecord.DeliveryRequest{
		Session: session, ExpectedEpoch: expected, Now: time.Now(), EndEpoch: !attributed,
		Candidates: []localrecord.DeliveryCandidate{{EntryID: in.Entry, Moment: "recall", Form: form, Action: in.Action,
			Level: in.Level, Mode: "on", Exempt: true, Resend: true}},
	})
	return err == nil && len(result.Receipts) == 1
}
