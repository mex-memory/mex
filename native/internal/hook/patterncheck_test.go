package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/pattern"
)

func runPatternCheck(t *testing.T, req patternCheckRequest) (int, []pattern.Verdict) {
	t.Helper()
	b, _ := json.Marshal(req)
	var out bytes.Buffer
	code := patternCheck(bytes.NewReader(b), &out)
	var reply struct {
		OK      bool              `json:"ok"`
		Results []pattern.Verdict `json:"results"`
	}
	_ = json.Unmarshal(out.Bytes(), &reply)
	return code, reply.Results
}

func TestPatternCheckReadsTheAreaFromTheIndex(t *testing.T) {
	root, mex := t.TempDir(), t.TempDir()
	files := map[string]string{
		"apps/api/a.ts": "import { format } from 'date-fns'\n",
		"apps/api/b.ts": "export const b = 1\n",
		"apps/api/c.ts": "console.log('debug')\n",
		"apps/api/d.ts": "console.log('more')\n",
		"apps/api/f.ts": "console.log('again')\n",
		"apps/web/e.ts": "import moment from 'moment'\n",
	}
	for p, text := range files {
		write(t, filepath.Join(root, filepath.FromSlash(p)), text)
	}
	fakeIndex(t, mex, "p1", root, "apps/api/a.ts", []byte(files["apps/api/a.ts"]), nil)
	db, err := sql.Open("sqlite", filepath.Join(index.Directory(mex, "p1"), "c-1.db"))
	if err != nil {
		t.Fatal(err)
	}
	for p, text := range files {
		if p != "apps/api/a.ts" {
			if _, err := db.Exec("INSERT INTO paths VALUES(?,'h','ts',0,?,'1',NULL,?)", p, len(text), filepath.Base(p)); err != nil {
				t.Fatal(err)
			}
		}
	}
	db.Close()

	req := patternCheckRequest{Checkout: root, ProjectID: "p1", RecordDirectory: mex, Scope: []string{"apps/api/**"}, Candidates: []pattern.Candidate{
		// Not in apps/api (only apps/web has it): kept.
		{Type: "anti", Match: "literal", Pattern: "from 'moment'", Objected: "import m from 'moment'", Fixed: "import { format } from 'date-fns'"},
		// In 3 of apps/api's 5 files: the area's normal code, dropped.
		{Type: "anti", Match: "structural", Pattern: "console.log($$$)", Objected: "console.log(x)", Fixed: "logger.info(x)"},
	}}
	code, got := runPatternCheck(t, req)
	if code != 0 || len(got) != 2 {
		t.Fatalf("code %d, %+v", code, got)
	}
	if !got[0].Keep || got[0].Files != 5 || got[0].Matched != 0 {
		t.Fatalf("moment: %+v", got[0])
	}
	if got[1].Keep || got[1].Matched != 3 || !strings.Contains(got[1].Reason, "3 of the area's 5 files") {
		t.Fatalf("console.log: %+v", got[1])
	}

	// No index for the project: the share is unknown and anti patterns drop.
	req.ProjectID = "p2"
	if _, got := runPatternCheck(t, req); got[0].Keep || !strings.Contains(got[0].Reason, "unknown") {
		t.Fatalf("no index: %+v", got[0])
	}
}

func TestPatternCheckRejectsBadRequests(t *testing.T) {
	var out bytes.Buffer
	if code := patternCheck(strings.NewReader("{"), &out); code != 2 {
		t.Fatalf("bad JSON: %d", code)
	}
	many := patternCheckRequest{Checkout: t.TempDir(), Candidates: make([]pattern.Candidate, patternCheckMax+1)}
	if code, _ := runPatternCheck(t, many); code != 2 {
		t.Fatalf("too many candidates: %d", code)
	}
}
