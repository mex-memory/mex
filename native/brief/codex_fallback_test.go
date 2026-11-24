package brief

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/record/place"
)

func saveFallback(t *testing.T, opts Options, plan string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(opts.MexHome, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS settings (scope TEXT, key TEXT, value TEXT, PRIMARY KEY (scope,key))`); err != nil {
		t.Fatal(err)
	}
	root, err := place.RealPath(opts.Checkout)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO settings VALUES (?,?,?)`, "checkout:"+root, codexFallbackKey, plan); err != nil {
		t.Fatal(err)
	}
}

func TestCodexFallbackOrdersWholeRulesWithinItsOwnBudget(t *testing.T) {
	opts := setup(t)
	opts.IncludeCodexFallback = true
	put(t, opts.Checkout, "AGENTS.md", "Your own instructions.\n")
	plan := fallbackPlan{FrameBytes: 180, DefaultsHeading: "\n## MEX defaults\n\n", Defaults: []string{
		"- " + strings.Repeat("Default that won't fit. ", 22) + "\n", "- Brief default.\n",
	}}
	for i := 0; i < 16; i++ {
		id := fmt.Sprintf("mx_rule%02d", i)
		short := fmt.Sprintf("Rule %02d says use the stable branch.", i)
		long := short + " " + strings.Repeat("é", 271) + "."
		rule := strings.Replace(entry(id, short, "rule", "**", "[]"), "\n---\n"+short, "\n---\n"+long, 1)
		put(t, opts.Checkout, ".mex/learned/"+id+".md", rule)
		plan.Entries = append(plan.Entries, fallbackEntry{ID: id, Text: long, Line: fallbackEntryLine(long, id), Level: "team", Areas: []string{""}})
	}
	encoded, _ := json.Marshal(plan)
	saveFallback(t, opts, string(encoded))
	r := build(t, opts)
	fallback := r.CodexFallback
	if !strings.HasPrefix(fallback, codexFallbackHeading) || len(fallback) > codexFileBytes || len(fallback) < codexFileBytes-600 {
		t.Fatalf("fallback bytes: %d", len(fallback))
	}
	previous := -1
	for i, rule := range plan.Entries {
		next := strings.Index(fallback, rule.Line)
		if i < 13 {
			if next <= previous {
				t.Fatalf("missing or out of order: %s", rule.ID)
			}
			previous = next
		} else if next >= 0 {
			t.Fatalf("rule exceeded available space: %s", rule.ID)
		}
	}
	if !strings.Contains(fallback, "## MEX defaults") || !strings.HasSuffix(fallback, "Brief default.\n") || strings.Contains(fallback, "Default that won't fit") {
		t.Fatal("defaults did not yield to repository rules")
	}
	if strings.Contains(r.Text, "Rule 00") || strings.Contains(r.Text, "MEX defaults") || len(r.Items) == 0 {
		t.Fatal("the ordinary budget repeated a native fallback rule or skipped remaining rules", r.Text)
	}
	if len(r.NativeLoaded) != 13 {
		t.Fatal("missing receipts for fallback rules", len(r.NativeLoaded))
	}
}

func TestCodexFallbackRechecksPresenceScopeAndCache(t *testing.T) {
	opts := setup(t)
	opts.IncludeCodexFallback = true
	put(t, opts.Checkout, "pkg/AGENTS.override.md", "Use the local convention.")
	id, text := "mx_scoped1", "Keep local release notes in the release folder."
	put(t, opts.Checkout, ".mex/learned/"+id+".md", entry(id, text, "rule", "pkg/**", "[]"))
	plan := fallbackPlan{Entries: []fallbackEntry{{ID: id, Text: text, Line: fallbackEntryLine(text, id), Level: "team", Areas: []string{"pkg"}}}}
	encoded, _ := json.Marshal(plan)
	saveFallback(t, opts, string(encoded))
	if r := build(t, opts); r.CodexFallback != "" {
		t.Fatal("a folder outside the starting path affected the root")
	}
	opts.Path = "pkg/svc"
	if r := build(t, opts); !strings.Contains(r.CodexFallback, text) {
		t.Fatal("missing the override on the startup path", r)
	}
	put(t, opts.Checkout, ".mex/learned/"+id+".md", entry(id, "The rule was updated.", "rule", "pkg/**", "[]"))
	if r := build(t, opts); r.CodexFallback != "" {
		t.Fatal("stale plan text was delivered", r)
	}
	put(t, opts.Checkout, "pkg/AGENTS.md", "<!-- mex:generated -->\n- Our rule.\n")
	if err := os.Remove(filepath.Join(opts.Checkout, "pkg", "AGENTS.override.md")); err != nil {
		t.Fatal(err)
	}
	if r := build(t, opts); r.CodexFallback != "" {
		t.Fatal("the native slot was free", r)
	}
	put(t, opts.Checkout, "pkg/AGENTS.override.md", "Rule with priority.")
	saveFallback(t, opts, "{invalid")
	if r := build(t, opts); r.CodexFallback != "" || r.Text == "" {
		t.Fatal("corrupt fallback prevented the normal brief", r)
	}
}
