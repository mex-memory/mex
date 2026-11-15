package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/record/place"
)

func gitRepo(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	real, _ := place.RealPath(dir)
	g(t, real, "init", "-q", "-b", "main")
	gitAs(t, real, "alex@example.test")
	write(t, filepath.Join(real, "README.md"), "# r\n")
	g(t, real, "add", "README.md")
	g(t, real, "commit", "-q", "-m", "init")
	g(t, real, "checkout", "-q", "-b", "feat/billing")
	return real
}

func g(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return string(out)
}

func gitAs(t *testing.T, dir, email string) {
	t.Helper()
	g(t, dir, "config", "user.email", email)
	g(t, dir, "config", "user.name", strings.Split(email, "@")[0])
}

func startSession(t *testing.T, env Env, root, session, source string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": "SessionStart", "source": source, "cwd": root})
	_, out := run(t, []string{"claude-code", "SessionStart"}, bytes.NewReader(b), env)
	return out
}

func failCommand(t *testing.T, env Env, root, session, command string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": "PostToolUseFailure", "cwd": root, "tool_name": "Bash", "tool_input": map[string]any{"command": command}, "error": "Exit code 1\nboom"})
	run(t, []string{"claude-code", "PostToolUseFailure"}, bytes.NewReader(b), env)
}

func TestWhereWeLeftOffShownOnceNotOnResume(t *testing.T) {
	h, env := fakeHome(t, true)
	root := gitRepo(t)
	register(t, h, root, projectID, "on", "")
	run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("a", root, "make the parser stream large files"), env)
	failCommand(t, env, root, "a", "npm test")
	write(t, filepath.Join(root, "src", "parser.ts"), "x")

	// A resume carries its own history: nothing, and nothing is used up.
	if out := startSession(t, env, root, "b", "resume"); strings.Contains(out, "left off") {
		t.Fatalf("shown on resume: %s", out)
	}
	out := startSession(t, env, root, "c", "startup")
	for _, want := range []string{"Where the person left off on feat/billing", "make the parser stream large files", "`npm test` (exit 1)", "Uncommitted: src/", `[mex `} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	// About 100 tokens.
	var reply struct {
		Specific struct {
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	json.Unmarshal([]byte(out), &reply)
	if i := strings.Index(reply.Specific.Context, "Where the person"); i < 0 || capture.Tokens(reply.Specific.Context[i:]) > 130 {
		t.Fatalf("too long: %q", reply.Specific.Context)
	}
	// Once: another new session, from any agent, sees nothing.
	if out := startSession(t, env, root, "d", "startup"); strings.Contains(out, "left off") {
		t.Fatalf("shown twice: %s", out)
	}
	// Another branch has its own continuity.
	g(t, root, "checkout", "-q", "-b", "other")
	if out := startSession(t, env, root, "e", "startup"); strings.Contains(out, "left off") {
		t.Fatalf("wrong branch: %s", out)
	}
}

func TestWhereWeLeftOffGoesAway(t *testing.T) {
	cases := map[string]func(t *testing.T, root string){
		"after 14 days": func(t *testing.T, root string) {},
		"when a later commit leaves the tree clean": func(t *testing.T, root string) {
			g(t, root, "add", "-A")
			g(t, root, "commit", "-q", "-m", "work")
		},
		"when the branch merges": func(t *testing.T, root string) {
			g(t, root, "add", "-A")
			g(t, root, "commit", "-q", "-m", "work")
			write(t, filepath.Join(root, "loose.txt"), "still dirty")
			g(t, root, "checkout", "-q", "main")
			g(t, root, "merge", "-q", "--no-ff", "-m", "merge", "feat/billing")
			g(t, root, "checkout", "-q", "feat/billing")
		},
		"when the branch fast-forwards into main": func(t *testing.T, root string) {
			g(t, root, "add", "-A")
			g(t, root, "commit", "-q", "-m", "work")
			write(t, filepath.Join(root, "loose.txt"), "still dirty")
			g(t, root, "checkout", "-q", "main")
			g(t, root, "merge", "-q", "--ff-only", "feat/billing")
			g(t, root, "checkout", "-q", "feat/billing")
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := gitRepo(t)
			register(t, h, root, projectID, "on", "")
			run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("a", root, "finish the invoice export"), env)
			write(t, filepath.Join(root, "invoice.ts"), "x")
			path := capture.ContinuityPath(h.mex, root, "feat/billing")
			if name == "after 14 days" {
				c, ok := capture.ReadContinuity(h.mex, root, "feat/billing")
				if !ok {
					t.Fatal("no snapshot")
				}
				c.Updated = time.Now().Add(-15 * 24 * time.Hour).UTC().Format(time.RFC3339)
				b, _ := json.Marshal(c)
				write(t, path, string(b))
			}
			change(t, root)
			if out := startSession(t, env, root, "b", "startup"); strings.Contains(out, "left off") {
				t.Fatalf("still shown: %s", out)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("snapshot kept")
			}
		})
	}
}

func handoffFile(branch, body string) string {
	return "---\nmex: handoff\nversion: 1\nbranch: " + branch + "\nfrom: alex\ncreated: 2026-11-15\n---\n" + body + "\n"
}

func TestHandoffDeliveredOnceUntilClosed(t *testing.T) {
	h, env := fakeHome(t, true)
	root := gitRepo(t)
	register(t, h, root, projectID, "on", "")
	rel := capture.HandoffRel("feat/billing")
	if rel != ".mex/handoffs/feat-billing.md" {
		t.Fatal(rel)
	}
	write(t, filepath.Join(root, rel), handoffFile("feat/billing", "- Last ask: \"wire refunds into the invoice export\"\n- Next: the refund total is off by tax"))
	// Not committed yet: it is still with its author.
	gitAs(t, root, "sam@example.test")
	if out := startSession(t, env, root, "s0", "startup"); strings.Contains(out, "Handoff") {
		t.Fatalf("uncommitted handoff delivered: %s", out)
	}
	gitAs(t, root, "alex@example.test")
	g(t, root, "add", rel)
	g(t, root, "commit", "-q", "-m", "handoff")
	// The author's own sessions never receive it.
	if out := startSession(t, env, root, "a1", "startup"); strings.Contains(out, "Handoff") {
		t.Fatalf("author received it: %s", out)
	}
	// The receiver gets it once, on a new session, not on a resume.
	gitAs(t, root, "sam@example.test")
	if out := startSession(t, env, root, "s1", "resume"); strings.Contains(out, "Handoff") {
		t.Fatalf("resume: %s", out)
	}
	out := startSession(t, env, root, "s2", "startup")
	if !strings.Contains(out, "Handoff for feat/billing") || !strings.Contains(out, "refund total is off by tax") || !strings.Contains(out, "[mex ") {
		t.Fatalf("not delivered: %s", out)
	}
	if out := startSession(t, env, root, "s3", "startup"); strings.Contains(out, "Handoff") {
		t.Fatalf("delivered twice: %s", out)
	}
	// Another branch never sees it.
	g(t, root, "checkout", "-q", "-b", "elsewhere")
	if out := startSession(t, env, root, "s4", "startup"); strings.Contains(out, "Handoff") {
		t.Fatalf("other branch: %s", out)
	}
	g(t, root, "checkout", "-q", "feat/billing")

	// The receiver's first commit closes it, for any machine that hasn't
	// shown it yet.
	write(t, filepath.Join(root, "refund.ts"), "x")
	g(t, root, "add", "refund.ts")
	g(t, root, "commit", "-q", "-m", "refunds")
	h2, env2 := fakeHome(t, true)
	register(t, h2, root, projectID, "on", "")
	if out := startSession(t, env2, root, "m1", "startup"); strings.Contains(out, "Handoff") {
		t.Fatalf("closed handoff delivered: %s", out)
	}
}

func TestHandoffDraftDoesNotConsumeCommittedNotice(t *testing.T) {
	for _, staged := range []bool{false, true} {
		name := "unstaged"
		if staged {
			name = "staged"
		}
		t.Run(name, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := gitRepo(t)
			register(t, h, root, projectID, "on", "")
			rel := capture.HandoffRel("feat/billing")
			committed := handoffFile("feat/billing", "- Next: finish the committed refund work")
			write(t, filepath.Join(root, rel), committed)
			g(t, root, "add", rel)
			g(t, root, "commit", "-q", "-m", "handoff")
			gitAs(t, root, "sam@example.test")
			write(t, filepath.Join(root, rel), handoffFile("feat/billing", "- Next: an uncommitted replacement"))
			if staged {
				g(t, root, "add", rel)
			}
			if out := startSession(t, env, root, "draft", "startup"); strings.Contains(out, "Handoff for") || strings.Contains(out, "uncommitted replacement") {
				t.Fatalf("draft delivered under the old commit: %s", out)
			}
			// A normal CRLF checkout still matches the committed LF body.
			write(t, filepath.Join(root, rel), strings.ReplaceAll(committed, "\n", "\r\n"))
			if out := startSession(t, env, root, "restored", "startup"); !strings.Contains(out, "finish the committed refund work") || !strings.Contains(out, "[mex ") {
				t.Fatalf("draft consumed the committed notice: %s", out)
			}
			if out := startSession(t, env, root, "again", "startup"); strings.Contains(out, "Handoff for") {
				t.Fatalf("committed handoff delivered twice: %s", out)
			}
		})
	}
}
