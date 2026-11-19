package hook

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func waitingCompactOffers(directory string) bool {
	return exists(filepath.Join(directory, "compaction-offer-pending.claude-code")) ||
		exists(filepath.Join(directory, "compaction-offer-pending.codex"))
}

// Ask the background worker to inspect recent sessions on lifecycle events.
// The hook need not read transcripts or start an agent to check eligibility.
func requestCompactOffer(ev contract.Event, h home, directory string) bool {
	if ev.AgentID != "" || ev.SessionID == "" || directory == "" ||
		(ev.Agent != "claude-code" && ev.Agent != "codex") {
		return false
	}
	switch ev.Kind {
	case contract.SessionStart, contract.PreCompact, contract.PostCompact, contract.SessionEnd:
	default:
		return false
	}
	if capture.Scripted(ev.Agent, h.env) {
		return false
	}
	path := filepath.Join(directory, "compaction-offer-pending."+ev.Agent)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errors.Is(err, os.ErrExist)
	}
	return f.Close() == nil
}

func compactOfferNotice(ev contract.Event, h home, directory string, now time.Time) string {
	if ev.AgentID != "" || ev.SessionID == "" || ev.Checkout == "" {
		return ""
	}
	if ev.Kind != contract.SessionStart && (ev.Kind != contract.Prompt || ev.Prompt == nil || !ev.Prompt.Typed) {
		return ""
	}
	key, command := ev.Agent, "mex compact"
	switch ev.Agent {
	case "claude-code":
	case "codex":
		key += "." + place.ShortHash(ev.Checkout)
		command += " --agent codex"
	default:
		return ""
	}
	name := filepath.Join("compaction-offers", key)
	info, err := os.Lstat(filepath.Join(directory, name))
	if err != nil || !info.Mode().IsRegular() || info.Size() != 2 ||
		now.Sub(info.ModTime()) > 24*time.Hour || capture.Scripted(ev.Agent, h.env) {
		return ""
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return ""
	}
	defer root.Close()
	folder, err := root.Lstat("compaction-offers")
	if err != nil || !folder.IsDir() {
		return ""
	}
	current, err := root.Lstat(name)
	if err != nil || !os.SameFile(info, current) {
		return ""
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return ""
	}
	defer hooks.Close()
	session := localrecord.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}
	first, err := hooks.ShowOnce(session, "compaction.offer."+ev.Agent, now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return ""
	}
	_ = root.Remove(name)
	if !first {
		return ""
	}
	return "MEX measured enough long sessions to suggest a compaction window. Run " + command + " to review the offer."
}
