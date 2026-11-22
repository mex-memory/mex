package index

import (
	"encoding/json"
	"path"
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/index/shift"
)

// importExtensions are tried for a relative import, in the order bundlers
// try them. Must match EXTENSIONS in src/file-index/imports.ts.
var importExtensions = []string{"", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"}

var jsExtension = regexp.MustCompile(`\.(js|jsx|mjs|cjs)$`)

// resolveImport resolves a relative import (./x, ../x) of an indexed file to
// an indexed path. Package imports and paths outside the checkout name no
// file here. Must match resolveImport in src/file-index/imports.ts.
func resolveImport(from, importer string, known map[string]bool) (string, bool) {
	if !strings.HasPrefix(from, "./") && !strings.HasPrefix(from, "../") {
		return "", false
	}
	base := path.Clean(path.Join(path.Dir(importer), from))
	if base == ".." || strings.HasPrefix(base, "../") {
		return "", false
	}
	if known[base] {
		return base, true
	}
	stem := jsExtension.ReplaceAllString(base, "")
	for _, ext := range importExtensions {
		if known[stem+ext] {
			return stem + ext, true
		}
	}
	return "", false
}

// resolvesImports reports a language whose imports resolve to paths. Python,
// Rust and C# imports are recorded but name modules, not files, so a file in
// one of them can't prove it imports nothing.
func resolvesImports(lang string) bool {
	switch lang {
	case "ts", "tsx", "js":
		return true
	}
	return false
}

// ImportEdge is one import between two indexed files.
type ImportEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ImportsAnswer is every resolved import out of the files a glob matches,
// and the files whose imports couldn't be read, by reason. An answer with
// unread files is a lower bound, never proof that an import is absent.
type ImportsAnswer struct {
	AsOf   string         `json:"as_of"`
	Files  int            `json:"files"`
	Edges  []ImportEdge   `json:"edges"`
	Unread map[string]int `json:"unread"`
}

// ImportsFrom lists the relative imports of every file the glob matches, in
// path order. A file is unread when the index doesn't hold it, it changed
// since the parse (an edit may have changed its imports), or its language's
// imports don't resolve to paths. Files that aren't code are left out.
func (r *Reader) ImportsFrom(glob string) (*ImportsAnswer, error) {
	rows, err := r.scoped(normalizeGlob(glob))
	if err != nil {
		return nil, err
	}
	known, err := r.knownPaths()
	if err != nil {
		return nil, err
	}
	answer := &ImportsAnswer{AsOf: r.pointer.AsOf, Files: len(rows), Edges: []ImportEdge{}, Unread: map[string]int{}}
	for i := range rows {
		row := &rows[i]
		reason := r.importsUnread(row)
		if reason == "skip" {
			continue
		}
		if reason != "" {
			answer.Unread[reason]++
			continue
		}
		imports, ok := r.imports(row)
		if !ok {
			answer.Unread["not in the index"]++
			continue
		}
		seen := map[string]bool{}
		for _, from := range imports {
			to, ok := resolveImport(from, row.path, known)
			if ok && to != row.path && !seen[to] {
				seen[to] = true
				answer.Edges = append(answer.Edges, ImportEdge{From: row.path, To: to})
			}
		}
	}
	return answer, nil
}

// knownPaths is every indexed path. Snapshots never change, so it is read
// once per Reader.
func (r *Reader) knownPaths() (map[string]bool, error) {
	if r.known != nil {
		return r.known, nil
	}
	rows, err := r.db.Query("SELECT path FROM paths WHERE reason IS NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	known := map[string]bool{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		known[p] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	r.known = known
	return known, nil
}

// importsUnread says why a file's imports can't be read, or "" when they
// can or when it's not code ("skip": binaries, lockfiles, docs).
func (r *Reader) importsUnread(row *pathRow) string {
	switch {
	case row.why.Valid && (row.why.String == "binary" || row.why.String == "ignored"):
		return "skip"
	case row.lang.Valid && row.lang.String == "other":
		return "skip"
	case row.why.Valid:
		return row.why.String
	case !row.hash.Valid || !row.lang.Valid:
		return "not in the index"
	case !resolvesImports(row.lang.String):
		return "imports not resolved for " + row.lang.String
	case len(shift.Pending(r.directory, r.key, row.path, row.mtime)) > 0 || r.changedOnDisk(row.path, row.mtime, nil):
		return "changed since the last parse"
	}
	return ""
}

func (r *Reader) imports(row *pathRow) ([]string, bool) {
	var data string
	err := r.db.QueryRow("SELECT data FROM main.records WHERE hash=?1 AND lang=?2 UNION ALL SELECT data FROM base.records WHERE hash=?1 AND lang=?2 LIMIT 1",
		row.hash.String, row.lang.String).Scan(&data)
	if err != nil {
		return nil, false
	}
	var record struct {
		Imports []struct {
			From string `json:"from"`
		} `json:"imports"`
	}
	if json.Unmarshal([]byte(data), &record) != nil {
		return nil, false
	}
	out := make([]string, 0, len(record.Imports))
	for _, item := range record.Imports {
		out = append(out, item.From)
	}
	return out, true
}
