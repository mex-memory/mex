package graph

import (
	"database/sql"
	"os"
	"testing"
)

func TestV4BasicCallHints(t *testing.T) {
	schema, err := os.ReadFile("../../src/graph/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(string(schema) + `
INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at)
	VALUES ('caller.sample','caller-hash','sample',10,1,1), ('target.sample','target-hash','sample',10,1,1);
INSERT INTO nodes(id,kind,name,qualified_name,identity_key,file_path,language,start_line,end_line,start_column,end_column,updated_at)
	VALUES ('caller','function','caller','caller','caller','caller.sample','sample',1,2,0,1,1),
	       ('target','function','target','target','target','target.sample','sample',1,2,0,1,1);
INSERT INTO edges(source,target,kind,line,col,confidence,resolution_method)
	VALUES ('caller','target','calls',2,0,0,'basic');
CREATE TABLE coverage (path TEXT PRIMARY KEY, reason TEXT NOT NULL);
INSERT INTO coverage VALUES ('caller.sample','basic'), ('target.sample','basic');
`); err != nil {
		t.Fatal(err)
	}
	s := &Store{db: db, hashes: map[string]string{}}
	files := listedFiles{&fakeFiles{hashes: s.BuiltFiles()}}
	src := texts(map[string]string{})
	for _, op := range []Op{OpCallers, OpImpact, OpCallees} {
		name := "target"
		if op == OpCallees {
			name = "caller"
		}
		answer, err := Ask(s, files, src, op, name)
		if err != nil || answer.Verdict != Unknown || answer.Complete || len(answer.Sites) != 0 {
			t.Fatalf("%s(%s) = %+v, %v", op, name, answer, err)
		}
	}
}
