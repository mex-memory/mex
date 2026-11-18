package delivery

import (
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
)

// A rule stated in passing ("we always use pnpm here") is easy for an agent to
// act on for the task and forget to keep. RulePrompt quotes it back to the
// agent for this turn, so it can save it with `mex note`; the agent judges
// whether it is a lasting rule, and the person approves the command. No model,
// no cost unless a sentence matches.
var (
	ruleCue      = regexp.MustCompile(`(?i)\b(?:always|never|from now on|going forward|in future|in the future|remember|make sure (?:to|you)|we (?:use|prefer|don'?t use|do not use)|do not (?:use|run|edit|touch|commit|push)|don'?t (?:ever |use|run|edit|touch|commit|push))\b`)
	ruleSentence = regexp.MustCompile(`[^.!?\n]+[.!?]?`)
	ruleFence    = regexp.MustCompile("(?s)```.*?```|`[^`\n]*`")
)

const maxRuleQuote = 200

// RulePrompt returns one line for a prompt that states what looks like a
// lasting rule, or "" when none does.
func RulePrompt(ev contract.Event) string {
	if ev.Kind != contract.Prompt || ev.Prompt == nil || !ev.Prompt.Typed || ev.ProjectID == "" || ev.AgentID != "" || ev.Background {
		return ""
	}
	sentence := ruleSentenceIn(ev.Prompt.Text)
	if sentence == "" {
		return ""
	}
	return `MEX: the person said "` + strings.TrimRight(sentence, ".!") + `". If that is a lasting rule or fact about this repo, not a one-off request, save it in their words with mex note "<their words>" and tell them.`
}

func ruleSentenceIn(text string) string {
	if len(text) > 16*1024 {
		text = text[:16*1024]
	}
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(strings.ToLower(trimmed), "mex note") {
		return "" // already a note: the typed form is saved by the hook itself
	}
	// Code and quoted commands are not statements.
	plain := ruleFence.ReplaceAllStringFunc(text, func(s string) string {
		if strings.HasPrefix(s, "```") {
			return " "
		}
		return s
	})
	for _, s := range ruleSentence.FindAllString(plain, 64) {
		s = strings.TrimSpace(s)
		if strings.HasSuffix(s, "?") || len(strings.Fields(s)) < 4 || !ruleCue.MatchString(s) {
			continue
		}
		if len(s) > maxRuleQuote {
			s = strings.TrimSpace(s[:maxRuleQuote]) + "…"
		}
		return strings.ReplaceAll(s, `"`, `'`)
	}
	return ""
}
