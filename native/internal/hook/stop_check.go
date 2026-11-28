package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const stopCheckPending = "learn-stop-pending"
const stopCheckPointers = "learn-stop-pointers"

var stopCheckProject = regexp.MustCompile(`^[gf]-[a-f0-9]{24}$`)
var stopCheckEntry = regexp.MustCompile(`^mx_[a-z0-9]{6,64}$`)

func stopCheckEnabled(directory, project string) bool {
	if directory == "" || !stopCheckProject.MatchString(project) {
		return false
	}
	var setting struct {
		Version   int  `json:"version"`
		StopCheck bool `json:"stop_check"`
	}
	return readControl(filepath.Join(directory, "hook-delivery", project+".json"), &setting) == nil && setting.Version == 1 && setting.StopCheck
}

type stopCheckRule struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths"`
}

type stopCheckRequest struct {
	Project  string          `json:"project"`
	Checkout string          `json:"checkout"`
	Agent    string          `json:"agent"`
	Session  string          `json:"session"`
	At       int64           `json:"at"`
	Head     string          `json:"head"`
	Rules    []stopCheckRule `json:"rules"`
}

// Use the Stop hook's existing wake-up path. It records only scoped paths and
// rule ids. No Git command or model runs on Stop.
func requestStopCheck(ev contract.Event, h home, directory string, now time.Time) bool {
	if ev.Checkout == "" || ev.SessionID == "" || len(ev.SessionID) > 512 || ev.AgentID != "" ||
		(ev.Agent != "claude-code" && ev.Agent != "codex") || !stopCheckEnabled(directory, ev.ProjectID) {
		return false
	}
	name := place.ShortHash(ev.Checkout) + ".json"
	changed := loadChanged(changedPath(directory, ev)).Lines
	// The paired edit recorder also has paths a single adapter might not place
	// in the delivery line map. Its hashes carry no source text.
	var observed judgeEdits
	if data, err := boundedJudgeRead(filepath.Join(directory, "judge-edits", name), judgeEditBytes); err != nil ||
		json.Unmarshal(data, &observed) != nil || observed.Version != 1 || observed.Project != ev.ProjectID ||
		observed.Checkout != ev.Checkout || observed.Agent != ev.Agent || observed.SessionID != ev.SessionID {
		observed = judgeEdits{}
	}
	if len(changed) == 0 && len(observed.Edits) == 0 {
		return false
	}
	paths := map[string]bool{}
	add := func(path string) {
		if rel, ok := place.RelativeToCheckout(ev.Checkout, path); ok {
			rel = filepath.ToSlash(rel)
			if len(rel) <= 300 && !strings.ContainsAny(rel, "\r\n\x00") {
				paths[rel] = true
			}
		}
	}
	for path := range changed {
		add(path)
	}
	for _, edit := range observed.Edits {
		add(filepath.Join(ev.Checkout, filepath.FromSlash(edit.Path)))
	}
	if len(paths) == 0 {
		return false
	}
	snapshot, err := entries.LoadLight(directory, h.mex, ev.ProjectID, ev.Checkout)
	if err != nil {
		return false
	}
	retired := map[string]bool{}
	for _, id := range snapshot.Retired {
		retired[id] = true
	}
	request := stopCheckRequest{Project: ev.ProjectID, Checkout: ev.Checkout, Agent: ev.Agent, Session: ev.SessionID, At: now.UnixMilli(), Head: observed.Position.Head}
	broadLearned := entries.CheckoutBroadLearned(directory, ev.ProjectID, ev.Checkout)
	for _, item := range snapshot.Items {
		e := item.Entry
		if e.Status != "active" || e.Kind != "rule" || !e.Learned() || item.Level == "hint" || retired[e.ID] || len(e.When) != 0 {
			continue
		}
		var scoped []string
		for path := range paths {
			for _, scope := range item.Scopes {
				if scope.MatchString(path) {
					scoped = append(scoped, path)
					break
				}
			}
		}
		if len(scoped) > 0 && !broadLearned(e) {
			sort.Strings(scoped)
			request.Rules = append(request.Rules, stopCheckRule{e.ID, scoped[:min(len(scoped), 8)]})
		}
		if len(request.Rules) == 3 {
			break
		}
	}
	if len(request.Rules) == 0 {
		return false
	}
	data, err := json.Marshal(request)
	if err != nil || len(data) > 16<<10 {
		return false
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return false
	}
	defer root.Close()
	return writeJudgeLocal(root, stopCheckPending, name, data)
}

type stopCheckFlag struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Line int    `json:"line"`
	Hash string `json:"hash"`
}

type stopCheckPointer struct {
	Project  string          `json:"project"`
	Checkout string          `json:"checkout"`
	At       int64           `json:"at"`
	Flags    []stopCheckFlag `json:"flags"`
	Session  string          `json:"session,omitempty"`
	Agent    string          `json:"agent,omitempty"`
}

// Claim after rendering, only on a supported prompt. The exclusive claim
// prevents two concurrently submitted prompts from carrying the same pointer.
func stopCheckPrompt(ev contract.Event, h home, directory string, now time.Time) (string, func(bool)) {
	if ev.Kind != contract.Prompt || ev.Prompt == nil || !ev.Prompt.Typed || ev.Checkout == "" || ev.SessionID == "" || len(ev.SessionID) > 512 || ev.AgentID != "" {
		return "", nil
	}
	name := place.ShortHash(ev.Checkout)
	file := filepath.Join(directory, stopCheckPointers, name+".json")
	data, err := boundedJudgeRead(file, 4096)
	if err != nil || !stopCheckEnabled(directory, ev.ProjectID) {
		return "", nil
	}
	var pointer stopCheckPointer
	if json.Unmarshal(data, &pointer) != nil || pointer.Project != ev.ProjectID || pointer.Checkout != ev.Checkout ||
		pointer.Session != "" || len(pointer.Flags) == 0 || len(pointer.Flags) > 3 || now.UnixMilli()-pointer.At > (7*24*time.Hour).Milliseconds() {
		return "", nil
	}
	for _, flag := range pointer.Flags {
		if !stopCheckEntry.MatchString(flag.ID) {
			return "", nil
		}
	}
	snapshot, err := entries.LoadLight(directory, h.mex, ev.ProjectID, ev.Checkout)
	if err != nil {
		return "", nil
	}
	broadLearned := entries.CheckoutBroadLearned(directory, ev.ProjectID, ev.Checkout)
	var lines []string
	var flags []stopCheckFlag
	for _, flag := range pointer.Flags {
		for _, item := range snapshot.Items {
			e := item.Entry
			if e.ID == flag.ID && e.Status == "active" && e.Learned() && e.Kind == "rule" && len(e.When) == 0 && !broadLearned(e) {
				lines = append(lines, "MEX thinks your last change may break a learned rule: `mex recall "+flag.ID+"`")
				flags = append(flags, flag)
				break
			}
		}
	}
	if len(flags) == 0 {
		return "", nil
	}
	pointer.Flags = flags
	root, err := os.OpenRoot(directory)
	if err != nil {
		return "", nil
	}
	lock := filepath.Join(stopCheckPointers, name+".lock")
	if stat, err := root.Lstat(lock); err == nil && now.Sub(stat.ModTime()) > time.Minute {
		_ = root.Remove(lock)
	}
	f, err := root.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		_ = root.Close()
		return "", nil
	}
	_ = f.Close()
	if current, err := boundedJudgeRead(file, 4096); err != nil || string(current) != string(data) {
		_ = root.Remove(lock)
		_ = root.Close()
		return "", nil
	}
	return strings.Join(lines, "\n"), func(sent bool) {
		defer root.Close()
		defer root.Remove(lock)
		if !sent {
			return
		}
		pointer.At, pointer.Session, pointer.Agent = now.UnixMilli(), ev.SessionID, ev.Agent
		body, err := json.Marshal(pointer)
		if err == nil && writeJudgeLocal(root, stopCheckPointers, name+".shown", body) {
			_ = root.Remove(filepath.Join(stopCheckPointers, name+".json"))
		}
	}
}
