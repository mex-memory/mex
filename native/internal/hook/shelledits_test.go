package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func TestShellEditsReachGraphCards(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git required for worktree diff")
	}
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := t.TempDir()
			runCommand := func(name string, args ...string) {
				t.Helper()
				cmd := exec.CommandContext(t.Context(), name, args...)
				cmd.Dir = root
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("%s %v: %v\n%s", name, args, err, out)
				}
			}
			runCommand("git", "init", "-q")
			register(t, h, root, projectID, "on", "")
			const before = "export function area(\n  width: number,\n): number {\n  return width;\n}\n"
			write(t, filepath.Join(root, "area.ts"), before)
			var callers []string
			for i := 1; i <= 6; i++ {
				callers = append(callers, fmt.Sprintf("caller%d.ts", i))
			}
			callers = append(callers, "area.test.ts")
			for _, rel := range callers {
				write(t, filepath.Join(root, rel), "import { area } from './area';\nfunction caller() {\n  return area(1);\n}\n")
			}
			runCommand("git", "add", "--", ".")
			runCommand("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture")
			fakeIndex(t, h.mex, projectID, root, "area.ts", []byte(before), []shift.Symbol{{Name: "area", Kind: "function", Start: 1, End: 5}})
			plantShellEditGraph(t, h.mex, root, callers)
			call := func(event string, fields map[string]any) string {
				t.Helper()
				fields["cwd"], fields["session_id"], fields["hook_event_name"] = root, "shell-edits", event
				payload, err := json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				_, out := run(t, []string{agent, event}, bytes.NewReader(payload), env)
				return out
			}
			call("SessionStart", map[string]any{"source": "startup"})
			// An earlier edit tool updated one caller, and the shell updates
			// another alongside the signature. Both still call area.
			const oldCall, newCall = "  return area(1);", "  return area(1, 2);"
			editedCaller := filepath.Join(root, callers[0])
			current, err := os.ReadFile(editedCaller)
			if err != nil {
				t.Fatal(err)
			}
			write(t, editedCaller, strings.Replace(string(current), oldCall, newCall, 1))
			if agent == "claude-code" {
				call("PostToolUse", map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": editedCaller, "old_string": oldCall, "new_string": newCall}, "tool_response": "edited"})
			} else {
				patch := "*** Begin Patch\n*** Update File: " + callers[0] + "\n@@\n-" + oldCall + "\n+" + newCall + "\n*** End Patch"
				call("PostToolUse", map[string]any{"tool_name": "apply_patch", "tool_input": map[string]any{"command": patch}, "tool_response": "edited"})
			}
			var command string
			tool := "Bash"
			if runtime.GOOS == "windows" {
				const script = `[IO.File]::WriteAllText('area.ts', [IO.File]::ReadAllText('area.ts').Replace('width: number,', 'width: number, height: number,')); [IO.File]::WriteAllText('caller2.ts', [IO.File]::ReadAllText('caller2.ts').Replace('area(1)', 'area(1, 2)'))`
				// PowerShell's current directory and the process directory can differ.
				runCommand("powershell", "-NoProfile", "-Command", "[Environment]::CurrentDirectory = (Get-Location).Path; "+script)
				command, tool = script, "PowerShell"
			} else {
				const script = `sed 's/width: number,/width: number, height: number,/' area.ts > area.tmp && cat area.tmp > area.ts && sed 's/area(1)/area(1, 2)/' caller2.ts > caller.tmp && cat caller.tmp > caller2.ts`
				runCommand("sh", "-c", script)
				command = "sh -c '" + script + "'"
			}
			if agent == "codex" {
				tool = "exec_command"
			}
			shell := func(command, output string) map[string]any {
				return map[string]any{"tool_name": tool, "tool_input": map[string]any{"command": command}, "tool_response": output}
			}
			out := call("PostToolUse", shell(command, "done"))
			if agent == "claude-code" {
				if strings.Contains(out, "used by") {
					t.Fatalf("used-by card before batch: %s", out)
				}
				out = call("PostToolBatch", map[string]any{"tool_calls": []any{shell(command, "done")}})
			}
			if !strings.Contains(out, "height: number") || !strings.Contains(out, "used by 5 files") || strings.Contains(out, "caller1.ts") || strings.Contains(out, "caller2.ts") {
				t.Fatalf("used-by card: %s", out)
			}
			changed := loadChanged(changedPath(h.mex, contract.Event{Agent: agent, SessionID: "shell-edits"}))
			if len(changed.Lines) != 3 || len(changed.ShellMtimes) != 2 {
				t.Fatalf("session changes: %+v", changed)
			}
			out = call("PostToolUse", shell("npm test", strings.Repeat("PASS packages/api/test case completed successfully\n", 80)))
			if !strings.Contains(out, "Tests covering your changes: area.test.ts (direct)") {
				t.Fatalf("tests card: %s", out)
			}
		})
	}
}

// Keep the published graph and file index on the same version of the fixture.
func plantShellEditGraph(t *testing.T, recordDirectory, root string, callers []string) {
	t.Helper()
	dir := index.Directory(recordDirectory, projectID)
	open := func(file string) *sql.DB {
		t.Helper()
		db, err := sql.Open("sqlite", filepath.Join(dir, file))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return db
	}
	execSQL := func(db *sql.DB, query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	const base = "graph-base-test.db"
	g := open(base)
	execSQL(g, `CREATE TABLE files(path TEXT PRIMARY KEY, content_hash TEXT);
CREATE TABLE nodes(id TEXT PRIMARY KEY, name TEXT, file_path TEXT, start_line INT, end_line INT, kind TEXT, is_exported INT, signature TEXT, body_hash TEXT, container_id TEXT);
CREATE TABLE edges(source TEXT, target TEXT, kind TEXT, line INT);
CREATE TABLE unresolved_refs(reference_name TEXT, from_node_id TEXT, status TEXT, reference_kind TEXT, candidates TEXT, line INT);`)
	execSQL(g, `INSERT INTO nodes VALUES('area', 'area', 'area.ts', 1, 5, 'function', 1, '', '', NULL)`)
	ix := open("c-1.db")
	const hash = "0123456789abcdef0123456789abcdef"
	const outline = `{"outline":[{"name":"caller","kind":"function","start":2,"end":4}],"tokens":24,"lines":4}`
	execSQL(ix, `INSERT INTO records VALUES(?, 'ts', ?)`, hash, outline)
	for i, rel := range callers {
		info, err := os.Stat(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		mtime := strconv.FormatInt(info.ModTime().UnixNano(), 10)
		execSQL(ix, `INSERT INTO paths VALUES(?, ?, 'ts', ?, ?, ?, NULL, ?)`, rel, hash, strings.HasSuffix(rel, ".test.ts"), info.Size(), mtime, rel)
		id := strconv.Itoa(i)
		execSQL(g, `INSERT INTO files VALUES(?, ?)`, rel, hash)
		execSQL(g, `INSERT INTO nodes VALUES(?, 'caller', ?, 2, 4, 'function', 0, '', '', NULL)`, id, rel)
		execSQL(g, `INSERT INTO edges VALUES(?, 'area', 'calls', 3)`, id)
	}
	ix.Close()
	g.Close()
	real, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	pointer, err := json.Marshal(map[string]any{"version": 1, "root": real, "base": base, "as_of": "2026-11-15T10:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "graph-checkouts", place.ShortHash(real)+".json"), string(pointer))
	mirror, err := json.Marshal(shift.Checkout{ProjectID: projectID, Root: real})
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(recordDirectory, "index-checkouts", place.ShortHash(real)+".json"), string(mirror))
}
