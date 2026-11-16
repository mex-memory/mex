package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func judgeRepo(t *testing.T) string {
	t.Helper()
	root := repo(t, t.TempDir())
	root, _ = place.RealPath(root)
	write(t, filepath.Join(root, ".git", "HEAD"), "ref: refs/heads/work\n")
	write(t, filepath.Join(root, ".git", "refs", "heads", "work"), strings.Repeat("a", 40)+"\n")
	return root
}

func recordedJudgeEdits(t *testing.T, directory, checkout string) judgeEdits {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "judge-edits", place.ShortHash(checkout)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var state judgeEdits
	if err = json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestJudgeEditProvesExactBeforeAndAfterWithoutCodeText(t *testing.T) {
	directory, checkout := t.TempDir(), judgeRepo(t)
	file := filepath.Join(checkout, "api.ts")
	write(t, file, "before code\n")
	old, next := "before", "after"
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "claude-code", SessionID: "session", Kind: contract.PreTool,
		Tool: &contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: file, Old: &old, New: &next}}}
	noteJudgeEdits(ev, directory)
	pre := recordedJudgeEdits(t, directory, checkout)
	if pre.Pending == nil || len(pre.Edits) != 0 {
		t.Fatalf("pre claims an edit: %+v", pre)
	}
	write(t, file, "after code\n")
	ev.Kind, ev.Tool.Output = contract.PostTool, &contract.ToolOutput{OK: true}
	noteJudgeEdits(ev, directory)
	post := recordedJudgeEdits(t, directory, checkout)
	if post.Pending != nil || len(post.Edits) != 1 || *post.Edits[0].Before != judgeHash([]byte("before code\n")) || *post.Edits[0].After != judgeHash([]byte("after code\n")) {
		t.Fatalf("wrong proof: %+v", post)
	}
	data, _ := os.ReadFile(filepath.Join(directory, "judge-edits", place.ShortHash(checkout)+".json"))
	if strings.Contains(string(data), "before code") || strings.Contains(string(data), "after code") {
		t.Fatal("source text escaped into provenance")
	}
	// A second paired edit extends the original baseline, rather than losing it.
	old, next = "after", "newest"
	ev.Kind, ev.Tool.Output = contract.PreTool, nil
	noteJudgeEdits(ev, directory)
	write(t, file, "newest code\n")
	ev.Kind, ev.Tool.Output = contract.PostTool, &contract.ToolOutput{OK: true}
	noteJudgeEdits(ev, directory)
	post = recordedJudgeEdits(t, directory, checkout)
	if len(post.Edits) != 1 || *post.Edits[0].Before != judgeHash([]byte("before code\n")) || *post.Edits[0].After != judgeHash([]byte("newest code\n")) {
		t.Fatalf("chain lost: %+v", post)
	}
}

func TestJudgeEditCannotClaimAnUnpairedFailedOrRacingEdit(t *testing.T) {
	for _, mode := range []string{"post-only", "failed", "other-session", "other-input", "other-bytes", "branch", "outside", "oversized", "read"} {
		t.Run(mode, func(t *testing.T) {
			directory, checkout := t.TempDir(), judgeRepo(t)
			file := filepath.Join(checkout, "api.ts")
			old, next := "before", "after"
			write(t, file, old)
			ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", SessionID: "session", Kind: contract.PreTool,
				Tool: &contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: file, Old: &old, New: &next}}}
			if mode == "outside" {
				ev.Tool.Input.Path = filepath.Join(t.TempDir(), "elsewhere.ts")
			}
			if mode == "oversized" {
				write(t, file, strings.Repeat("x", judgeEditBytes+1))
			}
			if mode == "read" {
				ev.Tool.Name = contract.ToolRead
			}
			if mode != "post-only" {
				noteJudgeEdits(ev, directory)
			}
			write(t, file, next)
			ev.Kind, ev.Tool.Output = contract.PostTool, &contract.ToolOutput{OK: mode != "failed"}
			if mode == "other-session" {
				ev.SessionID = "other"
			}
			if mode == "other-input" {
				replacement := "different"
				ev.Tool.Input.New = &replacement
			}
			if mode == "other-bytes" {
				write(t, file, "someone else's edit")
			}
			if mode == "branch" {
				write(t, filepath.Join(checkout, ".git", "HEAD"), "ref: refs/heads/other\n")
				write(t, filepath.Join(checkout, ".git", "refs", "heads", "other"), strings.Repeat("a", 40))
			}
			noteJudgeEdits(ev, directory)
			data, err := os.ReadFile(filepath.Join(directory, "judge-edits", place.ShortHash(checkout)+".json"))
			if os.IsNotExist(err) {
				return
			}
			var state judgeEdits
			if err != nil || json.Unmarshal(data, &state) != nil || len(state.Edits) != 0 {
				t.Fatalf("claimed ambiguous edit: %s %v", data, err)
			}
		})
	}
}

func TestJudgeGitMoveClearsOwnership(t *testing.T) {
	directory, checkout := t.TempDir(), judgeRepo(t)
	write(t, filepath.Join(directory, "judge-edits", place.ShortHash(checkout)+".json"), "old proof")
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", SessionID: "session", Kind: contract.PreTool,
		Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "git pull --rebase"}}}
	noteJudgeEdits(ev, directory)
	if _, err := os.Stat(filepath.Join(directory, "judge-edits", place.ShortHash(checkout)+".json")); !os.IsNotExist(err) {
		t.Fatal("pull left ownership live")
	}
}

func TestJudgeWritePatchAndDeleteProvenance(t *testing.T) {
	for _, mode := range []string{"write", "patch", "delete", "skipped-path", "duplicate-path"} {
		t.Run(mode, func(t *testing.T) {
			directory, checkout := t.TempDir(), judgeRepo(t)
			file, after := filepath.Join(checkout, "api.ts"), "after\n"
			write(t, file, "before\n")
			tool := &contract.Tool{Name: contract.ToolWrite, Input: contract.ToolInput{Path: file, Content: &after}}
			if mode != "write" {
				patch := contract.PatchFile{Path: file, Kind: "update", Hunks: []contract.Hunk{{Old: "before\n", New: after}}}
				if mode == "delete" {
					patch.Kind = "delete"
				}
				tool = &contract.Tool{Name: contract.ToolPatch, Input: contract.ToolInput{Files: []contract.PatchFile{patch}}}
				if mode == "skipped-path" {
					tool.Input.Files = append([]contract.PatchFile{{Path: ""}}, tool.Input.Files...)
				}
				if mode == "duplicate-path" {
					tool.Input.Files = append(tool.Input.Files, patch)
				}
			}
			ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", SessionID: "session", Kind: contract.PreTool, Tool: tool}
			noteJudgeEdits(ev, directory)
			if mode == "delete" {
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			} else {
				write(t, file, after)
			}
			ev.Kind, tool.Output = contract.PostTool, &contract.ToolOutput{OK: true}
			noteJudgeEdits(ev, directory)
			state := recordedJudgeEdits(t, directory, checkout)
			if mode == "duplicate-path" {
				if len(state.Edits) != 0 {
					t.Fatal("ambiguous duplicate patch claimed ownership")
				}
				return
			}
			if len(state.Edits) != 1 || *state.Edits[0].Before != judgeHash([]byte("before\n")) {
				t.Fatalf("wrong proof: %+v", state)
			}
			if mode == "delete" {
				if state.Edits[0].After != nil {
					t.Fatal("delete attested to existing bytes")
				}
			} else if *state.Edits[0].After != judgeHash([]byte(after)) {
				t.Fatal("wrong after bytes")
			}
		})
	}
}

func TestJudgeGitMetadataSupportsPackedRefsAndLinkedWorktrees(t *testing.T) {
	checkout := judgeRepo(t)
	if at, ok := judgeGitPosition(checkout); !ok || at.Branch != "refs/heads/work" {
		t.Fatalf("loose: %+v %v", at, ok)
	}
	if err := os.Remove(filepath.Join(checkout, ".git", "refs", "heads", "work")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(checkout, ".git", "packed-refs"), "# pack-refs\n"+strings.Repeat("a", 40)+" refs/heads/work\n")
	if _, ok := judgeGitPosition(checkout); !ok {
		t.Fatal("packed ref unavailable")
	}
	worktree := t.TempDir()
	gitdir := filepath.Join(checkout, ".git", "worktrees", "linked")
	write(t, filepath.Join(worktree, ".git"), "gitdir: "+gitdir+"\n")
	write(t, filepath.Join(gitdir, "HEAD"), "ref: refs/heads/work\n")
	write(t, filepath.Join(gitdir, "commondir"), "../..\n")
	if at, ok := judgeGitPosition(worktree); !ok || at.Head != strings.Repeat("a", 40) {
		t.Fatalf("worktree: %+v %v", at, ok)
	}
	write(t, filepath.Join(gitdir, "HEAD"), strings.Repeat("a", 40)+"\n")
	if _, ok := judgeGitPosition(worktree); ok {
		t.Fatal("detached head claimed a branch")
	}
}
