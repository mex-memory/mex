package capture

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// A handoff is .mex/handoffs/<branch slug>.md in the repo, written by
// `mex handoff` with no AI and committed by its author (sheet 56). It is
// delivered once at session start on that branch, to anyone but its author,
// until it closes: the branch merged, or the receiver committed on it.

const (
	maxHandoffFile = 16 << 10
	// maxHandoffText bounds what goes to the model: about 100-200 tokens.
	maxHandoffText = 1000
)

var slugUnsafe = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`[^A-Za-z0-9._-]+`) })

// HandoffSlug turns a branch name into a file name. src/knowledge/handoff.ts
// holds the same rule.
func HandoffSlug(branch string) string {
	s := strings.Trim(slugUnsafe().ReplaceAllString(branch, "-"), "-.")
	if len(s) > 100 {
		s = strings.TrimRight(s[:100], "-.")
	}
	if s == "" {
		return "branch"
	}
	return s
}

// HandoffRel is the handoff's repo-relative path for a branch.
func HandoffRel(branch string) string { return ".mex/handoffs/" + HandoffSlug(branch) + ".md" }

// Handoff is a parsed handoff file.
type Handoff struct {
	Branch string
	From   string
	Body   string
}

// ParseHandoff reads the front matter and body of a handoff file.
func ParseHandoff(text string) (Handoff, bool) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	rest, ok := strings.CutPrefix(text, "---\n")
	if !ok {
		return Handoff{}, false
	}
	front, body, ok := strings.Cut(rest, "\n---\n")
	if !ok {
		return Handoff{}, false
	}
	var h Handoff
	kind := ""
	for _, line := range strings.Split(front, "\n") {
		k, v, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "mex":
			kind = v
		case "branch":
			h.Branch = v
		case "from":
			h.From = v
		}
	}
	h.Body = strings.TrimSpace(body)
	if kind != "handoff" || h.Branch == "" || h.Body == "" {
		return Handoff{}, false
	}
	return h, true
}

// readHandoff reads the branch's handoff from the working tree. Redirected
// folders or files are ignored.
func readHandoff(checkout, branch string) (string, bool) {
	dir := checkout
	for _, part := range []string{".mex", "handoffs"} {
		dir = filepath.Join(dir, part)
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() {
			return "", false
		}
	}
	text, err := readSmall(filepath.Join(dir, HandoffSlug(branch)+".md"), maxHandoffFile)
	if err != nil {
		return "", false
	}
	h, ok := ParseHandoff(text)
	if !ok || h.Branch != branch {
		return "", false
	}
	return strings.ReplaceAll(text, "\r\n", "\n"), true
}

// HandoffCarry builds the handoff block for a new session on its branch.
func HandoffCarry(ev contract.Event) (Carry, bool) {
	if ev.AgentID != "" || ev.Checkout == "" || ev.SessionID == "" {
		return Carry{}, false
	}
	branch := Branch(ev.Checkout)
	if branch == "" {
		return Carry{}, false
	}
	working, ok := readHandoff(ev.Checkout, branch)
	if !ok {
		return Carry{}, false
	}
	rel := HandoffRel(branch)
	// The commit that wrote it, and its author. An uncommitted handoff is
	// still with its author.
	out, err := git(ev.Checkout, "log", "-1", "--format=%H%x00%ae", "--", rel)
	commit, author, found := strings.Cut(strings.TrimSpace(out), "\x00")
	if err != nil || !found || !isSHA(commit) {
		return Carry{}, false
	}
	// Bind the delivered body to the commit used for its author and notice.
	// A local edit (staged or unstaged) is still a draft and must not consume
	// the committed handoff's once-only notice. Accept checkout CRLF only.
	committed, err := git(ev.Checkout, "cat-file", "blob", commit+":"+rel)
	if err != nil || len(committed) > maxHandoffFile || strings.ReplaceAll(committed, "\r\n", "\n") != working {
		return Carry{}, false
	}
	h, ok := ParseHandoff(committed)
	if !ok || h.Branch != branch {
		return Carry{}, false
	}
	if HandoffClosed(ev.Checkout, branch, commit, author) {
		return Carry{}, false
	}
	if me, err := git(ev.Checkout, "config", "user.email"); err == nil && strings.EqualFold(strings.TrimSpace(me), author) {
		return Carry{}, false // the author doesn't receive their own handoff
	}
	body := Redact(h.Body)
	if len(body) > maxHandoffText {
		body = clip(body, maxHandoffText-len("…")) + "…"
	}
	text := "Handoff for " + branch + " from a teammate (written by `mex handoff`, not verified):\n" + body
	return Carry{EntryID: "mex:handoff", NoticeID: "handoff:" + place.ShortHash(ev.Checkout+"\x00"+branch+"\x00"+commit), Text: text, Tokens: Tokens(text)}, true
}

// HandoffClosed reports a handoff that closed itself: its branch merged, or
// someone other than its author committed on the branch after it.
func HandoffClosed(checkout, branch, commit, author string) bool {
	if Merged(checkout, branch, Head(checkout, branch)) {
		return true
	}
	out, err := git(checkout, "log", "--format=%ae", commit+"..HEAD")
	if err != nil {
		return false
	}
	for _, email := range strings.Fields(out) {
		if !strings.EqualFold(email, author) {
			return true
		}
	}
	return false
}
