package graph

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/record/place"
)

// Use the engine's schema with deterministic rows so the Go suite needs no
// Rust binary. The overlay only adds new codes and reuses surviving keys.
func openV5Fixture(t *testing.T, overlay bool) *Store {
	t.Helper()
	root := t.TempDir()
	records := t.TempDir()
	project := "g-0123456789abcdef01234567"
	directory := index.Directory(records, project)
	if err := os.MkdirAll(filepath.Join(directory, "graph-checkouts"), 0700); err != nil {
		t.Fatal(err)
	}
	schema, err := os.ReadFile("../engine/core/src/schema_v5.sql")
	if err != nil {
		t.Fatal(err)
	}
	write := func(name, rows string) {
		t.Helper()
		db, err := sql.Open("sqlite", filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		if _, err := db.Exec(string(schema) + rows); err != nil {
			t.Fatal(err)
		}
	}
	p := pointer{Version: 1, Base: "graph-base-fixture.db", AsOf: "2026-11-22T00:00:00.000Z"}
	p.Root, err = place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	key := place.ShortHash(p.Root)
	write(p.Base, v5TestBase)
	if overlay {
		name := "graph-o-" + key + "-fixture.db"
		write(name, v5TestOverlay)
		p.Overlay = &name
	}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "graph-checkouts", key+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(records, project, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

const v5TestBase = `
INSERT INTO languages VALUES (1,'typescript');
INSERT INTO node_kinds VALUES (1,'file'), (2,'function'), (3,'class'), (4,'method'), (5,'interface');
INSERT INTO edge_kinds VALUES (7,'calls'), (15,'references'), (21,'imports');
INSERT INTO provenances VALUES (1,'typescript-compiler');
INSERT INTO resolution_methods VALUES (1,'engine-ecmascript');
INSERT INTO unresolved_reasons VALUES (1,'ambiguous'), (2,'untyped_receiver'), (3,'unresolved_import');
INSERT INTO unresolved_names VALUES (1,'run'), (2,'dynamicOnly'), (3,'obj["dynamicOnly"]'), (4,'missing'), (5,'main');
WITH seed(id,path,digit) AS (VALUES
	(1,'src/service.ts','A'), (2,'src/entry.ts','B'), (3,'src/obsolete.ts','C'),
	(4,'test/service.test.ts','D'), (5,'src/static.ts','E'))
INSERT INTO files SELECT id, path, unhex(replace(hex(zeroblob(32)), '0', digit)), 1, 100, 1, 0, 0, 0, 0, 'fixture'
	FROM seed;
WITH seed(id,kind,file,parent,name,qualified,start,end,signature,flags) AS (VALUES
	(1,1,1,NULL,'service.ts','service.ts',1,22,NULL,0),
	(2,3,1,1,'Service','Service',2,9,NULL,1),
	(3,4,1,2,'run','Service::run',3,5,'run(): number',3),
	(4,5,1,1,'Runner','Runner',10,12,NULL,0),
	(5,4,1,4,'run','Runner::run',11,11,NULL,0),
	(6,2,1,1,'run','run',15,17,NULL,0),
	(7,2,1,1,'dynamicOnly','dynamicOnly',18,19,NULL,0),
	(8,2,1,1,'quiet','quiet',20,22,NULL,0),
	(11,2,2,NULL,'main','main',2,12,NULL,2),
	(12,2,2,11,'<callback:entry>','main::<callback:entry>',5,8,NULL,0),
	(13,2,2,11,'local','main::local',9,11,NULL,0),
	(14,2,2,NULL,'gone','gone',14,15,NULL,0),
	(21,2,3,NULL,'old','old',1,4,NULL,0),
	(31,2,4,NULL,'checksRun','checksRun',1,3,NULL,0),
	(32,2,4,NULL,'checksMain','checksMain',4,6,NULL,0),
	(41,2,5,NULL,'staticCaller','staticCaller',1,4,NULL,0),
	(42,2,5,NULL,'help','help',5,7,NULL,0))
INSERT INTO nodes(id,public_id,kind,file,parent,name,qualified_name,start_line,start_col,end_line,end_col,signature,flags,body_hash)
	SELECT id, unhex(printf('%032x',id)), kind, file, parent, name, qualified, start, 0, end, 0, signature, flags,
	       CASE WHEN signature IS NOT NULL THEN unhex(replace(hex(zeroblob(32)), '0', 'F')) END
	FROM seed;
WITH seed(source,kind,target,line) AS (VALUES
	(11,15,3,3), (11,7,13,4), (12,7,3,7), (13,7,42,-1),
	(14,7,3,14), (21,7,3,2), (31,7,3,2), (32,7,11,5), (41,7,11,2))
INSERT INTO edges(source,kind,target,line,col,provenance,confidence,method,sequence)
	SELECT source, kind, target, line, -1, 1, 1, 1, row_number() OVER () FROM seed;
INSERT INTO unresolved_calls(id,source,name,kind,reason,line,col,candidate,written_name) VALUES
	(1,12,1,7,1,6,0,3,NULL), (2,12,2,7,2,8,0,NULL,3), (3,21,1,7,2,3,0,NULL,NULL),
	(4,14,2,7,2,15,0,NULL,NULL), (5,41,5,7,1,3,0,11,NULL), (6,13,4,7,2,10,0,NULL,NULL);
INSERT INTO unresolved_other VALUES (1,12,4,21,3,8,0);
INSERT INTO coverage VALUES ('src/unindexed.ts','file limit');
`

const v5TestOverlay = `
CREATE TABLE overlay_info (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
INSERT INTO overlay_info VALUES ('base','graph-base-fixture.db');
CREATE TABLE shadow_files (path TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
INSERT INTO shadow_files VALUES ('src/entry.ts'), ('src/obsolete.ts');
INSERT INTO node_kinds VALUES (1099511627777,'route');
INSERT INTO files VALUES (2,'src/entry.ts',unhex(replace(hex(zeroblob(32)), '0', 'F')),1,100,2,0,0,0,0,'fixture');
WITH seed(id,kind,parent,name,qualified,start,end) AS (VALUES
	(11,2,NULL,'main','main',2,16),
	(12,2,11,'<callback:entry>','main::<callback:entry>',10,14),
	(1099511627777,1099511627777,NULL,'freshRoute','freshRoute',17,20))
INSERT INTO nodes(id,public_id,kind,file,parent,name,qualified_name,start_line,start_col,end_line,end_col,flags)
	SELECT id, unhex(printf('%032x',id)), kind, 2, parent, name, qualified, start, 0, end, 0, 1 FROM seed;
INSERT INTO edges(source,kind,target,line,col,provenance,confidence,method,sequence) VALUES (12,7,3,12,0,1,1,1,1);
INSERT INTO unresolved_calls(id,source,name,kind,reason,line,col,candidate)
	VALUES (1099511627777,12,1,7,1,13,0,3);
`

func v5FixtureID(kind string, key int64) string { return fmt.Sprintf("%s:%032x", kind, key) }

func v5SiteNames(sites []Site) []string {
	names := make([]string, len(sites))
	for i, site := range sites {
		names[i] = fmt.Sprintf("%s:%d:%s:%t", site.In.Name, site.Line, site.Kind, site.Through)
	}
	return names
}

func TestV5Store(t *testing.T) {
	s := openV5Fixture(t, false)
	runID, mainID := v5FixtureID("method", 3), v5FixtureID("function", 11)
	run, ok := s.Node(runID)
	if !ok || run != (Symbol{ID: runID, Name: "run", Path: "src/service.ts", Start: 3, End: 5,
		Kind: "method", Exported: true, Signature: "run(): number", Hash: strings.Repeat("f", 64)}) {
		t.Fatalf("Node(run) = %+v, %v", run, ok)
	}
	if _, ok := s.Node(v5FixtureID("function", 3)); ok {
		t.Fatal("Node matched a public ID with a different kind")
	}
	if main, ok := s.Node(mainID); !ok || main.Exported || main.Hash != "" {
		t.Fatalf("Node(main) = %+v, %v", main, ok)
	}
	defs, err := s.Resolve("./service.ts:Service.run")
	if err != nil || !slices.Equal(defs, []Symbol{run}) {
		t.Fatalf("Resolve(file and owner) = %+v, %v", defs, err)
	}
	defs, err = s.Resolve("run")
	if err != nil || len(defs) != 3 || defs[0] != run || defs[1].Start != 11 || defs[2].Start != 15 {
		t.Fatalf("Resolve(run) = %+v, %v", defs, err)
	}
	if selector := s.Selector(run, defs); selector != "Service.run" {
		t.Fatalf("Selector = %q", selector)
	}
	if preferred, ok := s.Preferred(defs, Query{Name: "run"}); !ok || preferred != defs[2] {
		t.Fatalf("Preferred top-level = %+v, %v", preferred, ok)
	}
	if preferred, ok := s.Preferred(defs[:2], Query{Name: "run"}); !ok || preferred != run {
		t.Fatalf("Preferred bodied method = %+v, %v", preferred, ok)
	}
	declared, err := s.Declared("src/service.ts")
	if err != nil || len(declared) != 7 || declared[0].Kind != "class" || declared[1] != run || declared[6].Name != "quiet" {
		t.Fatalf("Declared = %+v, %v", declared, err)
	}

	callers, err := s.Callers(runID)
	if want := []string{"main:3:value:false", "<callback:entry>:6:call:true", "<callback:entry>:7:call:false",
		"gone:14:call:false", "old:2:call:false", "checksRun:2:call:false"}; err != nil || !slices.Equal(v5SiteNames(callers), want) {
		t.Fatalf("Callers(run) = %+v, %v", callers, err)
	}
	if owner := callers[1].Owner; owner == nil || owner.ID != mainID {
		t.Fatalf("callback owner = %+v", owner)
	}
	callees, err := s.Callees(mainID)
	if want := []string{"help:2:call:false", "run:3:value:false", "run:6:call:true", "run:7:call:false"}; err != nil || !slices.Equal(v5SiteNames(callees), want) {
		t.Fatalf("Callees(main) = %+v, %v", callees, err)
	}
	tests, err := s.Tests(runID)
	if err != nil || len(tests) != 2 || tests[0].Test.Name != "checksRun" || tests[0].Reach != Direct ||
		tests[1].Test.Name != "checksMain" || tests[1].Reach != ViaCaller || tests[1].Via != "main" || tests[1].Line != 5 {
		t.Fatalf("Tests(run) = %+v, %v", tests, err)
	}
	if run, dynamic, quiet, within := s.Unresolved(runID), s.Unresolved(v5FixtureID("function", 7)),
		s.Unresolved(v5FixtureID("function", 8)), s.UnresolvedIn(mainID); run != 1 || dynamic != 2 || quiet != 0 || within != 3 {
		t.Fatalf("unresolved run=%d dynamicOnly=%d quiet=%d within main=%d", run, dynamic, quiet, within)
	}
	if hash, ok := s.BuiltHash("src/entry.ts"); !ok || hash != strings.Repeat("b", 32) {
		t.Fatalf("BuiltHash = %q, %v", hash, ok)
	}
	if files := s.BuiltFiles(); len(files) != 5 || files["test/service.test.ts"] != strings.Repeat("d", 32) {
		t.Fatalf("BuiltFiles = %+v", files)
	}
	if s.Complete() {
		t.Fatal("coverage gaps must make the base incomplete")
	}
}

func TestV5StoreOverlay(t *testing.T) {
	s := openV5Fixture(t, true)
	mainID, runID := v5FixtureID("function", 11), v5FixtureID("method", 3)
	if main, ok := s.Node(mainID); !ok || main.End != 16 {
		t.Fatalf("overlay replacement = %+v, %v", main, ok)
	}
	if _, ok := s.Node(v5FixtureID("function", 21)); ok {
		t.Fatal("deleted file's node survives")
	}
	declared, err := s.Declared("src/entry.ts")
	if err != nil || len(declared) != 3 || declared[1].Name != "<callback:entry>" || declared[2].ID != v5FixtureID("route", 1099511627777) {
		t.Fatalf("overlay declarations = %+v, %v", declared, err)
	}
	if defs, err := s.Resolve("gone"); err != nil || len(defs) != 0 {
		t.Fatalf("old definition = %+v, %v", defs, err)
	}
	callers, err := s.Callers(runID)
	if want := []string{"<callback:entry>:12:call:false", "<callback:entry>:13:call:true", "checksRun:2:call:false"}; err != nil || !slices.Equal(v5SiteNames(callers), want) {
		t.Fatalf("overlay Callers(run) = %+v, %v", callers, err)
	}
	if owner := callers[0].Owner; owner == nil || owner.ID != mainID || owner.End != 16 {
		t.Fatalf("overlay owner = %+v", owner)
	}
	callees, err := s.Callees(mainID)
	if want := []string{"run:12:call:false", "run:13:call:true"}; err != nil || !slices.Equal(v5SiteNames(callees), want) {
		t.Fatalf("overlay Callees(main) = %+v, %v", callees, err)
	}
	incoming, err := s.Callers(mainID)
	if want := []string{"staticCaller:2:call:false", "staticCaller:3:call:true", "checksMain:5:call:false"}; err != nil || !slices.Equal(v5SiteNames(incoming), want) {
		t.Fatalf("base callers of replaced node = %+v, %v", incoming, err)
	}
	tests, err := s.Tests(runID)
	if err != nil || len(tests) != 2 || tests[1].Test.Name != "checksMain" || tests[1].Via != "main" {
		t.Fatalf("overlay Tests(run) = %+v, %v", tests, err)
	}
	if unresolved, within := s.Unresolved(runID), s.UnresolvedIn(mainID); unresolved != 0 || within != 0 {
		t.Fatalf("overlay unresolved run=%d within main=%d", unresolved, within)
	}
	if hash, ok := s.BuiltHash("src/entry.ts"); !ok || hash != strings.Repeat("f", 32) {
		t.Fatalf("overlay BuiltHash = %q, %v", hash, ok)
	}
	if hash, ok := s.BuiltHash("src/obsolete.ts"); ok {
		t.Fatalf("tombstone BuiltHash = %q", hash)
	}
	if files := s.BuiltFiles(); len(files) != 4 || files["src/obsolete.ts"] != "" || files["src/entry.ts"] != strings.Repeat("f", 32) {
		t.Fatalf("overlay BuiltFiles = %+v", files)
	}
	from := func(path string) bool { return path == "src/entry.ts" }
	to := func(path string) bool { return path == "src/service.ts" }
	n, src, dst, line, complete, err := s.CallsBetween("src/", "src/service", from, to)
	if err != nil || !complete || n != 2 || !from(src) || !to(dst) || line != 12 {
		t.Fatalf("overlay CallsBetween = %d, %q:%d -> %q, complete=%v, %v", n, src, line, dst, complete, err)
	}
}
