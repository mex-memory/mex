package hook

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/adapter/claude"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/outline"
	"github.com/mex-memory/mex/native/outline/outlinetest"
	"github.com/mex-memory/mex/native/record/place"
)

// fakeIndex writes a file index for one file the way the Node indexer does
// (contract: file-index.md), so the hook reads it through native/index.
func fakeIndex(t *testing.T, recordDirectory, project, root, rel string, content []byte, symbols []shift.Symbol) {
	t.Helper()
	real, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	dir := index.Directory(recordDirectory, project)
	if err := os.MkdirAll(filepath.Join(dir, "checkouts"), 0o700); err != nil {
		t.Fatal(err)
	}
	// The index serves a file only while its time on disk matches the parse.
	mtime := "1"
	if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
		mtime = strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	sum := sha256.Sum256(content)
	hash := hex.EncodeToString(sum[:])[:32]
	data, _ := json.Marshal(map[string]any{"outline": symbols, "tokens": len(content) / 4, "lines": strings.Count(string(content), "\n")})
	for _, name := range []string{"base-1.db", "c-1.db"} {
		db, err := sql.Open("sqlite", filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		stmts := []string{"CREATE TABLE records(hash TEXT NOT NULL, lang TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash, lang)) WITHOUT ROWID"}
		if name == "c-1.db" {
			stmts = append(stmts,
				"CREATE TABLE paths(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, is_test INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, reason TEXT, name TEXT NOT NULL) WITHOUT ROWID")
		}
		for _, s := range stmts {
			if _, err := db.Exec(s); err != nil {
				t.Fatal(err)
			}
		}
		if name == "c-1.db" {
			lang := shift.LangOf(rel)
			if _, err := db.Exec("INSERT INTO records VALUES(?,?,?)", hash, lang, string(data)); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("INSERT INTO paths VALUES(?,?,?,0,?,?,NULL,?)", rel, hash, lang, len(content), mtime, filepath.Base(rel)); err != nil {
				t.Fatal(err)
			}
		}
		db.Close()
	}
	pointer, _ := json.Marshal(index.Pointer{Version: index.StoreVersion, Root: real, Snapshot: "c-1.db", Base: "base-1.db", AsOf: "2026-11-15T10:00:00Z"})
	write(t, filepath.Join(dir, "checkouts", place.ShortHash(real)+".json"), string(pointer))
}

type readCase struct {
	h     home
	env   Env
	root  string
	file  string
	lines int
}

func setupRead(t *testing.T) readCase {
	t.Helper()
	reads, err := outlinetest.SavedReads()
	if err != nil {
		t.Fatal(err)
	}
	var r outlinetest.SavedRead
	for _, x := range reads {
		if x.Name == "cli.ts" {
			r = x
		}
	}
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	file := filepath.Join(root, "src", "cli.ts")
	write(t, file, r.Content)
	fakeIndex(t, h.mex, projectID, root, "src/cli.ts", []byte(r.Content), r.Symbols)
	return readCase{h, env, root, file, strings.Count(r.Content, "\n")}
}

func (c readCase) payload(t *testing.T, event, tool string, input map[string]any, response any) []byte {
	t.Helper()
	body := map[string]any{"session_id": "s1", "cwd": c.root, "hook_event_name": event, "tool_name": tool, "tool_input": input}
	if response != nil {
		body["tool_response"] = response
	}
	b, _ := json.Marshal(body)
	return b
}

func (c readCase) readResponse(t *testing.T) map[string]any {
	content, _ := os.ReadFile(c.file)
	return map[string]any{"type": "text", "file": map[string]any{"filePath": c.file, "content": string(content), "numLines": c.lines, "startLine": 1, "totalLines": c.lines}}
}

func (c readCase) call(t *testing.T, event string, payload []byte) claudeReply {
	t.Helper()
	_, out := run(t, []string{"claude-code", event}, bytes.NewReader(payload), c.env)
	return parseClaude(t, out)
}

func (c readCase) prompt(t *testing.T, text string) {
	b, _ := json.Marshal(map[string]any{"session_id": "s1", "cwd": c.root, "hook_event_name": "UserPromptSubmit", "prompt": text})
	run(t, []string{"claude-code", "UserPromptSubmit"}, bytes.NewReader(b), c.env)
}

var outlineHeader = regexp.MustCompile(`^\[MEX: 1,485-line file shown as outline( \+ lines [^·]+)? · full text: Read offset=1 limit=1485\]`)

// The demo: a big file arrives as an outline once per context, the first
// blind edit is stopped once, the next full read becomes an explicit range,
// and after that the agent works normally.
func TestOutlineAndItsThreeRules(t *testing.T) {
	c := setupRead(t)
	c.prompt(t, "Add an option to buildCompletion for the out command")
	full := map[string]any{"file_path": c.file}
	r := c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", full, c.readResponse(t)))
	var replaced readResponse
	if err := json.Unmarshal(r.HookSpecificOutput.UpdatedToolOutput, &replaced); err != nil {
		t.Fatalf("not outlined: %+v", r)
	}
	if replaced.Type != "text" || !outlineHeader.MatchString(replaced.File.Content) || replaced.File.TotalLines != c.lines || replaced.File.StartLine != 1 {
		t.Fatalf("outline shape: %+v", replaced.File)
	}
	if !strings.Contains(replaced.File.Content, "1465-1485 function buildCompletion") || !strings.Contains(replaced.File.Content, "Lines 1465–1485:") {
		t.Fatalf("outline lacks the named function and its slice:\n%s", replaced.File.Content)
	}

	// Rule 2: the first edit is stopped once; the second goes through.
	edit := map[string]any{"file_path": c.file, "old_string": "a", "new_string": "b"}
	r = c.call(t, "PreToolUse", c.payload(t, "PreToolUse", "Edit", edit, nil))
	if r.HookSpecificOutput.PermissionDecision != "deny" || !strings.Contains(r.HookSpecificOutput.PermissionDecisionReason, "offset=1 limit=1485") {
		t.Fatalf("blind edit not stopped: %+v", r)
	}
	r = c.call(t, "PreToolUse", c.payload(t, "PreToolUse", "Edit", edit, nil))
	if r.HookSpecificOutput.PermissionDecision != "" {
		t.Fatalf("edit stopped twice: %+v", r)
	}

	// Rule 3: the next full read becomes an explicit range.
	r = c.call(t, "PreToolUse", c.payload(t, "PreToolUse", "Read", full, nil))
	var input map[string]any
	if json.Unmarshal(r.HookSpecificOutput.UpdatedInput, &input) != nil || input["offset"] != float64(1) || input["limit"] != float64(1485) || input["file_path"] != c.file || r.HookSpecificOutput.PermissionDecision != "" {
		t.Fatalf("full read not ranged: %s", r.HookSpecificOutput.UpdatedInput)
	}

	// Rule 1: once per context. The same full read is not outlined again...
	r = c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", full, c.readResponse(t)))
	if r.HookSpecificOutput.UpdatedToolOutput != nil {
		t.Fatal("outlined twice in one context")
	}
	// ...until a compaction starts a new context.
	b, _ := json.Marshal(map[string]any{"session_id": "s1", "cwd": c.root, "hook_event_name": "SessionStart", "source": "compact"})
	run(t, []string{"claude-code", "SessionStart"}, bytes.NewReader(b), c.env)
	c.prompt(t, "keep going")
	r = c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", full, c.readResponse(t)))
	if r.HookSpecificOutput.UpdatedToolOutput == nil {
		t.Fatal("not outlined in the new context")
	}
}

// A ranged read after the outline means the agent has the text: no edit stop.
func TestRangedReadSatisfiesTheEditGuard(t *testing.T) {
	c := setupRead(t)
	c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t)))
	c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file, "offset": 1460, "limit": 26}, c.readResponse(t)))
	r := c.call(t, "PreToolUse", c.payload(t, "PreToolUse", "Write", map[string]any{"file_path": c.file, "content": "x"}, nil))
	if r.HookSpecificOutput.PermissionDecision != "" {
		t.Fatalf("stopped after a ranged read: %+v", r)
	}
}

func TestReadsNotOutlined(t *testing.T) {
	cases := map[string]func(t *testing.T, c readCase) []byte{
		"a range was asked": func(t *testing.T, c readCase) []byte {
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file, "offset": 1, "limit": 2000}, c.readResponse(t))
		},
		"named in the prompt": func(t *testing.T, c readCase) []byte {
			c.prompt(t, "look at src/cli.ts please")
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t))
		},
		"named by its stem": func(t *testing.T, c readCase) []byte {
			c.prompt(t, "what does the cli do on start?")
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t))
		},
		"edited earlier": func(t *testing.T, c readCase) []byte {
			c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Edit", map[string]any{"file_path": c.file, "old_string": "a", "new_string": "a"}, map[string]any{"filePath": c.file}))
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t))
		},
		"changed since the index": func(t *testing.T, c readCase) []byte {
			content, _ := os.ReadFile(c.file)
			write(t, c.file, "// moved\n"+string(content))
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t))
		},
		"not a text read": func(t *testing.T, c readCase) []byte {
			return c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, map[string]any{"type": "image", "file": map[string]any{"base64": "x"}})
		},
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			c := setupRead(t)
			if r := c.call(t, "PostToolUse", payload(t, c)); r.HookSpecificOutput.UpdatedToolOutput != nil {
				t.Fatal("outlined")
			}
		})
	}
	for _, env := range []map[string]string{{"MEX_RAW": "1"}, {"MEX_OUTLINE": "0"}} {
		c := setupRead(t)
		c.env = withEnv(c.env, env)
		if r := c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t))); r.HookSpecificOutput.UpdatedToolOutput != nil {
			t.Fatalf("outlined with %v", env)
		}
	}
}

// When the guards trip on most outlines, outlines turn off on this machine,
// and the person is told once.
func TestOutlineKillSwitch(t *testing.T) {
	c := setupRead(t)
	told := 0
	for i := 0; i < killAfter; i++ {
		session := "k" + string(rune('a'+i))
		p := func(event, tool string, input map[string]any, resp any) []byte {
			body := map[string]any{"session_id": session, "cwd": c.root, "hook_event_name": event, "tool_name": tool, "tool_input": input}
			if resp != nil {
				body["tool_response"] = resp
			}
			b, _ := json.Marshal(body)
			return b
		}
		r := c.call(t, "PostToolUse", p("PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t)))
		if r.HookSpecificOutput.UpdatedToolOutput == nil {
			t.Fatalf("outline %d missing", i)
		}
		if r.SystemMessage != "" {
			told++
		}
		r = c.call(t, "PreToolUse", p("PreToolUse", "Edit", map[string]any{"file_path": c.file, "old_string": "a", "new_string": "b"}, nil))
		if r.SystemMessage != "" {
			told++
		}
	}
	if told != 1 || !readOutlineStats(c.h.mex).Off {
		t.Fatalf("kill switch: told %d, stats %+v", told, readOutlineStats(c.h.mex))
	}
	b, _ := json.Marshal(map[string]any{"session_id": "later", "cwd": c.root, "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": map[string]any{"file_path": c.file}, "tool_response": c.readResponse(t)})
	if r := c.call(t, "PostToolUse", b); r.HookSpecificOutput.UpdatedToolOutput != nil {
		t.Fatal("outlined after the kill switch")
	}
}

// Replay over saved reads, through the Claude Code profile: for every saved
// read the replaced tool output keeps Read's own shape.
func TestReplaySavedReadsThroughClaudeProfile(t *testing.T) {
	reads, err := outlinetest.SavedReads()
	if err != nil {
		t.Fatal(err)
	}
	profile := claude.Profile{}
	for _, r := range reads {
		t.Run(r.Name, func(t *testing.T) {
			lines := strings.Count(r.Content, "\n")
			raw, _ := json.Marshal(map[string]any{"session_id": "s", "cwd": "/repo", "hook_event_name": "PostToolUse", "tool_name": "Read",
				"tool_input":    map[string]any{"file_path": "/repo/" + r.Name},
				"tool_response": map[string]any{"type": "text", "file": map[string]any{"filePath": "/repo/" + r.Name, "content": r.Content, "numLines": lines, "startLine": 1, "totalLines": lines}}})
			ev, err := profile.Parse("PostToolUse", raw)
			if err != nil {
				t.Fatal(err)
			}
			words, _ := promptWords(r.Prompt)
			terms := map[uint64]bool{}
			for _, w := range words {
				terms[w] = true
			}
			res, ok := outline.Render(outline.Input{Path: r.Name, Content: r.Content, Symbols: r.Symbols, Terms: terms})
			if !ok {
				t.Fatal("not outlined")
			}
			out, dropped := profile.Render(ev, contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: res.Text, OK: true}})
			if len(dropped) > 0 {
				t.Fatalf("dropped %v", dropped)
			}
			var reply struct {
				HookSpecificOutput struct {
					HookEventName     string          `json:"hookEventName"`
					UpdatedToolOutput json.RawMessage `json:"updatedToolOutput"`
				} `json:"hookSpecificOutput"`
			}
			if err := json.Unmarshal(out, &reply); err != nil || reply.HookSpecificOutput.HookEventName != "PostToolUse" {
				t.Fatalf("reply %s", out)
			}
			var shape map[string]json.RawMessage
			var file map[string]any
			if json.Unmarshal(reply.HookSpecificOutput.UpdatedToolOutput, &shape) != nil || string(shape["type"]) != `"text"` || json.Unmarshal(shape["file"], &file) != nil {
				t.Fatalf("not Read's shape: %s", reply.HookSpecificOutput.UpdatedToolOutput)
			}
			content, _ := file["content"].(string)
			if content != res.Text || file["filePath"] != "/repo/"+r.Name || file["startLine"] != float64(1) || file["totalLines"] != float64(lines) ||
				file["numLines"] != float64(strings.Count(content, "\n")) || len(shape) != 2 || len(file) != 5 {
				t.Fatalf("file fields: %v", file)
			}
		})
	}
}
