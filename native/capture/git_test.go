package capture

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func captureGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func captureRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	captureGit(t, root, "init", "-q", "-b", "main")
	captureGit(t, root, "config", "user.name", "Alex")
	captureGit(t, root, "config", "user.email", "alex@example.test")
	for name, text := range map[string]string{"README.md": "initial\n", ".gitattributes": "README.md filter=probe\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	captureGit(t, root, "add", ".")
	captureGit(t, root, "commit", "-q", "-m", "initial")
	captureGit(t, root, "checkout", "-q", "-b", "feat/capture")
	return root
}

func shellQuote(path string) string {
	return "'" + strings.ReplaceAll(filepath.ToSlash(path), "'", "'\"'\"'") + "'"
}

func TestUncommittedDoesNotRunConfiguredPrograms(t *testing.T) {
	for _, kind := range []string{"fsmonitor", "clean", "process"} {
		t.Run(kind, func(t *testing.T) {
			root := captureRepo(t)
			marker := filepath.Join(root, ".git", "executed")
			script := filepath.Join(root, ".git", "configured helper.sh")
			body := "#!/bin/sh\nprintf called >> " + shellQuote(marker) + "\n"
			if kind == "fsmonitor" {
				body += "printf 'token\\0'\n"
			} else {
				body += "cat\n"
			}
			if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
				t.Fatal(err)
			}
			key := "filter.probe." + kind
			if kind == "fsmonitor" {
				key = "core.fsmonitor"
			}
			captureGit(t, root, "config", key, "sh "+shellQuote(script))
			// Same length forces a content comparison (and hence the clean
			// filter) rather than a stat-only size mismatch.
			if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("changed\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if kind != "process" {
				// Prove the helper really runs without the hook's guard.
				captureGit(t, root, "status", "--porcelain")
				if err := os.Remove(marker); err != nil {
					t.Fatalf("configured helper did not run: %v", err)
				}
			}
			index, err := os.ReadFile(filepath.Join(root, ".git", "index"))
			if err != nil {
				t.Fatal(err)
			}
			names, total, ok := Uncommitted(root, 4)
			if kind == "fsmonitor" && (!ok || total != 1 || len(names) != 1 || names[0] != "README.md") {
				t.Fatalf("status unavailable with monitor disabled: %v %d %v", names, total, ok)
			}
			if kind != "fsmonitor" && ok {
				t.Fatal("status must remain unknown when content filters could run")
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("hook ran the configured %s helper: %v", kind, err)
			}
			after, err := os.ReadFile(filepath.Join(root, ".git", "index"))
			if err != nil || string(index) != string(after) {
				t.Fatal("hook changed the index")
			}
		})
	}
}

func TestUncommittedDoesNotTreatUninspectedSubmodulesAsClean(t *testing.T) {
	root := captureRepo(t)
	head := captureGit(t, root, "rev-parse", "HEAD")
	captureGit(t, root, "update-index", "--add", "--cacheinfo", "160000,"+head+",sub")
	if _, _, ok := Uncommitted(root, 4); ok {
		t.Fatal("submodule state was not inspected and must remain unknown")
	}
}

func TestGitMetadataIgnoresInheritedRouting(t *testing.T) {
	root, other := captureRepo(t), captureRepo(t)
	captureGit(t, other, "config", "user.email", "other@example.test")
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "user.email")
	t.Setenv("GIT_CONFIG_VALUE_0", "injected@example.test")
	if value, err := git(root, "config", "user.email"); err != nil || strings.TrimSpace(value) != "alex@example.test" {
		t.Fatalf("inherited Git configuration redirected the read: %q %v", value, err)
	}
}
