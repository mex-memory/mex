package capture

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/mex-memory/mex/native/internal/captureprofile"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	approvalFolder    = "filter-approvals"
	approvalRetention = 30 * 24 * time.Hour
	maxApprovalFiles  = 128
	maxQuestions      = 8
	maxOptions        = 8
	maxChoicePayload  = 64 << 10
)

var approvalID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,512}$`)
var approvalFilename = regexp.MustCompile(`^[a-f0-9]{24}\.json$`)

type approvalOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
	Preview     string `json:"preview"`
}

type approvalQuestion struct {
	ID          string           `json:"id"`
	Question    string           `json:"question"`
	Header      string           `json:"header"`
	MultiSelect bool             `json:"multiSelect"`
	Options     []approvalOption `json:"options"`
}

type clickedChoice struct {
	Question int    `json:"question"`
	Option   int    `json:"option"`
	Label    string `json:"label,omitempty"`
	Text     string `json:"text"`
	Preview  string `json:"preview,omitempty"`
}

type clickedApproval struct {
	Version  int             `json:"version"`
	Project  string          `json:"project_id"`
	Checkout string          `json:"checkout"`
	Agent    string          `json:"agent"`
	Session  string          `json:"session_id"`
	Call     string          `json:"call_id"`
	Tool     string          `json:"tool"`
	At       string          `json:"at"`
	Kind     string          `json:"kind"`
	Level    string          `json:"level"`
	Strength string          `json:"strength"`
	Author   string          `json:"author"`
	Choices  []clickedChoice `json:"choices"`
}

func safeChoiceText(s string, maxBytes int) bool {
	return len(s) <= maxBytes && !HasSecret(s) && !strings.Contains(strings.ToLower(s), "<private") && strings.IndexFunc(s, func(r rune) bool {
		return unicode.Is(unicode.Cf, r) || unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t'
	}) == -1
}

// A response can identify only an unambiguous option from the corresponding
// question. Never save the contents of a free-form response or another option.
func selectedOptions(questions []approvalQuestion, key func(approvalQuestion) string, answers func(approvalQuestion) []string) []clickedChoice {
	if len(questions) == 0 || len(questions) > maxQuestions {
		return nil
	}
	keys := make(map[string]int, len(questions))
	for _, question := range questions {
		keys[key(question)]++
	}
	var choices []clickedChoice
	for index, question := range questions {
		id := key(question)
		if id == "" || keys[id] != 1 || len(question.Options) == 0 || len(question.Options) > maxOptions {
			continue
		}
		options := make(map[string]int, len(question.Options))
		for i, option := range question.Options {
			if _, duplicate := options[option.Label]; duplicate {
				options[option.Label] = -1
			} else {
				options[option.Label] = i
			}
		}
		selected := answers(question)
		if len(selected) == 0 || len(selected) > len(question.Options) {
			continue
		}
		var picks []clickedChoice
		for _, label := range selected {
			i, match := options[label]
			if !match || i < 0 || strings.TrimSpace(label) == "" || strings.EqualFold(strings.TrimSpace(label), "other") {
				break
			}
			delete(options, label) // A repeated answer is ambiguous.
			option := question.Options[i]
			if !safeChoiceText(label, 256) || !safeChoiceText(option.Description, 2048) || !safeChoiceText(option.Preview, 2048) {
				break
			}
			picks = append(picks, clickedChoice{Question: index + 1, Option: i + 1, Label: label, Text: option.Description, Preview: option.Preview})
		}
		if len(picks) == len(selected) {
			choices = append(choices, picks...)
		}
	}
	return choices
}

func claudeQuestionChoices(input json.RawMessage, output string) []clickedChoice {
	var asked struct {
		Questions []approvalQuestion `json:"questions"`
	}
	var result struct {
		Questions []approvalQuestion `json:"questions"`
		Answers   map[string]string  `json:"answers"`
		Response  *string            `json:"response"`
	}
	if json.Unmarshal(input, &asked) != nil || json.Unmarshal([]byte(output), &result) != nil || result.Response != nil ||
		!reflect.DeepEqual(asked.Questions, result.Questions) {
		return nil
	}
	return selectedOptions(asked.Questions, func(q approvalQuestion) string { return q.Question }, func(q approvalQuestion) []string {
		answer := result.Answers[q.Question]
		if !q.MultiSelect {
			return []string{answer}
		}
		for _, option := range q.Options {
			if strings.Contains(option.Label, ",") {
				return nil // Claude joins multiple selections with commas.
			}
		}
		parts := strings.Split(answer, ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		return parts
	})
}

func claudePlanChoice(input json.RawMessage, output string) []clickedChoice {
	var asked struct {
		Plan string `json:"plan"`
	}
	var result struct {
		Plan                   string `json:"plan"`
		IsAgent                *bool  `json:"isAgent"`
		AwaitingLeaderApproval bool   `json:"awaitingLeaderApproval"`
		PlanWasEdited          bool   `json:"planWasEdited"`
	}
	if json.Unmarshal(input, &asked) != nil || json.Unmarshal([]byte(output), &result) != nil ||
		result.IsAgent == nil || *result.IsAgent || result.AwaitingLeaderApproval || result.PlanWasEdited ||
		(asked.Plan != "" && asked.Plan != result.Plan) || strings.TrimSpace(result.Plan) == "" || !safeChoiceText(result.Plan, 12_000) {
		return nil
	}
	return []clickedChoice{{Question: 1, Option: 1, Text: result.Plan}}
}

func codexQuestionChoices(input json.RawMessage, output string) []clickedChoice {
	var asked struct {
		Questions []approvalQuestion `json:"questions"`
	}
	var result struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	if json.Unmarshal(input, &asked) != nil || json.Unmarshal([]byte(output), &result) != nil {
		return nil
	}
	return selectedOptions(asked.Questions, func(q approvalQuestion) string { return q.ID }, func(q approvalQuestion) []string {
		return result.Answers[q.ID].Answers
	})
}

// PostToolUse is the capture boundary. The supported profiles attach both
// tool input and its completed result to the same host tool-use ID.
func saveClickedApproval(ev contract.Event, env Env) error {
	t := ev.Tool
	if ev.Kind != contract.PostTool || !captureprofile.For(ev.Agent).Choices || ev.AgentID != "" || t == nil || t.Output == nil || !t.Output.OK || t.Output.Interrupted ||
		!approvalID.MatchString(t.UseID) || !approvalID.MatchString(ev.SessionID) || len(t.RawInput) > maxChoicePayload || len(t.Output.Text) > maxChoicePayload {
		return nil
	}
	var choices []clickedChoice
	switch {
	case ev.Agent == "claude-code" && t.RawName == "AskUserQuestion":
		choices = claudeQuestionChoices(t.RawInput, t.Output.Text)
	case ev.Agent == "claude-code" && t.RawName == "ExitPlanMode":
		choices = claudePlanChoice(t.RawInput, t.Output.Text)
	case ev.Agent == "codex" && t.RawName == "request_user_input":
		choices = codexQuestionChoices(t.RawInput, t.Output.Text)
	}
	if len(choices) == 0 {
		return nil
	}
	name := place.ShortHash(ev.ProjectID + "\x00" + ev.Checkout + "\x00" + ev.Agent + "\x00" + ev.SessionID + "\x00" + t.UseID)
	folder := filepath.Join(approvalFolder, place.ShortHash(ev.ProjectID+"\x00"+ev.Checkout))
	stamp := now(env)
	room, err := pruneApprovals(env.RecordDirectory, folder, stamp)
	if err != nil || !room {
		return err
	}
	return writeFilterFile(env.RecordDirectory, folder, name, clickedApproval{
		Version: 1, Project: ev.ProjectID, Checkout: ev.Checkout, Agent: ev.Agent, Session: ev.SessionID, Call: t.UseID,
		Tool: t.RawName, At: stamp.UTC().Format(time.RFC3339Nano), Kind: "approval", Level: "personal", Strength: "weak", Author: "agent", Choices: choices,
	}, true)
}

// Only choice capture pays for retention. The reader also excludes expired
// records, including in checkouts that haven't captured another choice yet.
func pruneApprovals(directory, folder string, stamp time.Time) (bool, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return false, err
	}
	defer root.Close()
	for _, part := range []string{approvalFolder, folder} {
		info, err := root.Lstat(part)
		if errors.Is(err, os.ErrNotExist) {
			return true, nil
		}
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false, errRedirected
		}
	}
	items, err := root.Open(folder)
	if err != nil {
		return false, err
	}
	defer items.Close()
	entries, err := items.ReadDir(maxApprovalFiles * 2)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	cutoff := stamp.Add(-approvalRetention)
	kept := 0
	for _, entry := range entries {
		if !approvalFilename.MatchString(entry.Name()) {
			continue
		}
		if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && !info.ModTime().After(cutoff) {
			if root.Remove(filepath.Join(folder, entry.Name())) == nil {
				continue
			}
		}
		kept++
	}
	return len(entries) < maxApprovalFiles*2 && kept < maxApprovalFiles, nil
}
