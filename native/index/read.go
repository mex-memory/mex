// Package index reads the file index that Node builds (contract: file-index.md)
// and writes the line shifts that keep it exact between an edit and the
// re-parse. It never parses, builds or waits: a missing index or file is an
// answer ("not indexed"), and the caller stays silent.
package index

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/record/place"
)

// StoreVersion must match STORE_VERSION in src/file-index/store.ts.
const StoreVersion = 1

// Pointer names a checkout's current snapshot and the project base it uses.
type Pointer struct {
	Version  int    `json:"version"`
	Root     string `json:"root"`
	Snapshot string `json:"snapshot"`
	Base     string `json:"base"`
	AsOf     string `json:"as_of"`
}

type Symbol = shift.Symbol

// Miss is the answer for a path the index has nothing on.
type Miss struct {
	Path       string `json:"path"`
	NotIndexed string `json:"not_indexed"`
}

type OutlineAnswer struct {
	Path    string   `json:"path"`
	AsOf    string   `json:"as_of"`
	Symbols []Symbol `json:"symbols"`
	Dropped int      `json:"dropped"`
}

type FileInfoAnswer struct {
	Path   string `json:"path"`
	Lang   string `json:"lang"`
	IsTest bool   `json:"is_test"`
	Tokens int    `json:"tokens"`
	Lines  int    `json:"lines"`
	Hash   string `json:"hash"`
}

type SymbolHit struct {
	Path  string `json:"path"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Kind  string `json:"kind"`
}

type CoverageAnswer struct {
	Files      int            `json:"files"`
	Indexed    int            `json:"indexed"`
	NotIndexed map[string]int `json:"not_indexed"`
}

// ErrNoIndex means the checkout has no index; callers stay silent.
var ErrNoIndex = errors.New("no index for this checkout")

// Directory is where a project's index lives, under the record's directory.
func Directory(recordDirectory, projectID string) string {
	return shift.Directory(recordDirectory, projectID)
}

// CheckoutKey names a checkout inside the index: ShortHash of its real path.
func CheckoutKey(root string) (string, error) {
	real, err := place.RealPath(root)
	if err != nil {
		return "", err
	}
	return place.ShortHash(real), nil
}

func readPointer(directory, key string) (Pointer, bool) {
	var pointer Pointer
	data, err := os.ReadFile(filepath.Join(directory, "checkouts", key+".json"))
	if err != nil || json.Unmarshal(data, &pointer) != nil || pointer.Version != StoreVersion {
		return Pointer{}, false
	}
	return pointer, true
}

// HasIndex reports whether a checkout has an index, without opening it.
func HasIndex(directory, key string) bool {
	_, ok := readPointer(directory, key)
	return ok
}

func immutableURI(file string) string {
	slash := filepath.ToSlash(file)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	u := url.URL{Scheme: "file", Path: slash, RawQuery: "mode=ro&immutable=1"}
	return u.String()
}

// Reader answers the six reads for one checkout. Close it when done.
type Reader struct {
	db         *sql.DB
	pointer    Pointer
	directory  string
	key        string
	root       string
	patternIDs map[string]bool
}

// Open opens a checkout's index read-only. Snapshots never change once
// written, so they open with SQLite's immutable flag: no locks, no waiting.
func Open(recordDirectory, projectID, checkout string) (*Reader, error) {
	root, err := place.RealPath(checkout)
	if err != nil {
		return nil, err
	}
	key := place.ShortHash(root)
	directory := Directory(recordDirectory, projectID)
	pointer, ok := readPointer(directory, key)
	if !ok {
		return nil, ErrNoIndex
	}
	db, err := sql.Open("sqlite", immutableURI(filepath.Join(directory, pointer.Snapshot)))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("ATTACH DATABASE ? AS base", immutableURI(filepath.Join(directory, pointer.Base))); err != nil {
		db.Close()
		return nil, err
	}
	return &Reader{db: db, pointer: pointer, directory: directory, key: key, root: root}, nil
}

func (r *Reader) Close() error { return r.db.Close() }

// AsOf is when the snapshot was written.
func (r *Reader) AsOf() string { return r.pointer.AsOf }

// relative turns a path into the index's form: relative to the checkout, '/'.
func (r *Reader) relative(path string) (string, bool) {
	if filepath.IsAbs(path) {
		return place.RelativeToCheckout(r.root, path)
	}
	value := strings.ReplaceAll(path, `\`, "/")
	for strings.HasPrefix(value, "./") {
		value = value[2:]
	}
	return value, value != ""
}

type pathRow struct {
	path, mtime     string
	hash, lang, why sql.NullString
	isTest          int
}

func (r *Reader) row(path string) (string, *pathRow, *Miss) {
	rel, ok := r.relative(path)
	if !ok {
		return path, nil, &Miss{path, "not in the index"}
	}
	var row pathRow
	err := r.db.QueryRow("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths WHERE path=?", rel).
		Scan(&row.path, &row.hash, &row.lang, &row.isTest, &row.mtime, &row.why)
	if err != nil {
		return rel, nil, &Miss{rel, "not in the index"}
	}
	if row.why.Valid || !row.hash.Valid || !row.lang.Valid {
		reason := "not in the index"
		if row.why.Valid {
			reason = row.why.String
		}
		return rel, nil, &Miss{rel, reason}
	}
	return rel, &row, nil
}

type recordData struct {
	Outline []Symbol `json:"outline"`
	Tokens  int      `json:"tokens"`
	Lines   int      `json:"lines"`
}

func (r *Reader) record(row *pathRow) (*recordData, bool) {
	var data string
	err := r.db.QueryRow("SELECT data FROM main.records WHERE hash=?1 AND lang=?2 UNION ALL SELECT data FROM base.records WHERE hash=?1 AND lang=?2 LIMIT 1",
		row.hash.String, row.lang.String).Scan(&data)
	if err != nil {
		return nil, false
	}
	var out recordData
	if json.Unmarshal([]byte(data), &out) != nil {
		return nil, false
	}
	return &out, true
}

// Outline is the symbols of one file with exact spans, or why there are none.
func (r *Reader) Outline(path string) (*OutlineAnswer, *Miss) {
	rel, row, miss := r.row(path)
	if miss != nil {
		return nil, miss
	}
	data, ok := r.record(row)
	if !ok {
		return nil, &Miss{rel, "not in the index"}
	}
	symbols, dropped, ok := shift.Apply(data.Outline, shift.Pending(r.directory, r.key, rel, row.mtime))
	if !ok {
		return nil, &Miss{rel, "changed since the last parse"}
	}
	return &OutlineAnswer{Path: rel, AsOf: r.pointer.AsOf, Symbols: symbols, Dropped: dropped}, nil
}

// FileInfo is a file's language, test flag, size in tokens and lines, and hash.
func (r *Reader) FileInfo(path string) (*FileInfoAnswer, *Miss) {
	rel, row, miss := r.row(path)
	if miss != nil {
		return nil, miss
	}
	data, ok := r.record(row)
	if !ok {
		return nil, &Miss{rel, "not in the index"}
	}
	return &FileInfoAnswer{Path: rel, Lang: row.lang.String, IsTest: row.isTest == 1, Tokens: data.Tokens, Lines: data.Lines, Hash: row.hash.String}, nil
}

// FilesNamed lists every path in the checkout with this file name.
func (r *Reader) FilesNamed(basename string) ([]string, error) {
	rows, err := r.db.Query("SELECT path FROM paths WHERE name=? ORDER BY path", basename)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

// SymbolsNamed lists definitions with this name, spans moved through pending edits.
func (r *Reader) SymbolsNamed(name string) ([]SymbolHit, error) {
	rows, err := r.db.Query(`SELECT p.path, p.mtime_ns, s.kind, s.start, s.end FROM
      (SELECT hash,lang,kind,start,end FROM main.symbols WHERE name=?1 UNION ALL SELECT hash,lang,kind,start,end FROM base.symbols WHERE name=?1) s
      JOIN paths p ON p.hash=s.hash AND p.lang=s.lang WHERE p.reason IS NULL ORDER BY p.path, s.start, s.end, s.kind`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []SymbolHit{}
	seen := map[SymbolHit]bool{}
	for rows.Next() {
		var path, mtime, kind string
		var start, end int
		if err := rows.Scan(&path, &mtime, &kind, &start, &end); err != nil {
			return nil, err
		}
		shifts := shift.Pending(r.directory, r.key, path, mtime)
		if shift.AnyUnknown(shifts) {
			continue
		}
		start, end, ok := shift.MapSpan(start, end, shifts)
		if !ok {
			continue
		}
		hit := SymbolHit{path, start, end, kind}
		if !seen[hit] {
			seen[hit] = true
			hits = append(hits, hit)
		}
	}
	return hits, rows.Err()
}

func (r *Reader) scoped(glob string) ([]pathRow, error) {
	pattern, err := globRegexp(glob)
	if err != nil {
		return nil, err
	}
	prefix := globPrefix(glob)
	var rows *sql.Rows
	if prefix != "" {
		rows, err = r.db.Query("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths WHERE path>=? AND path<? ORDER BY path", prefix, prefix+"\U0010FFFF")
	} else {
		rows, err = r.db.Query("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths ORDER BY path")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pathRow
	for rows.Next() {
		var row pathRow
		if err := rows.Scan(&row.path, &row.hash, &row.lang, &row.isTest, &row.mtime, &row.why); err != nil {
			return nil, err
		}
		if pattern.MatchString(row.path) {
			out = append(out, row)
		}
	}
	return out, rows.Err()
}

// PatternCounts sums literal pattern occurrences over the files in scope.
// Ids the index doesn't count are left out.
func (r *Reader) PatternCounts(scope string, ids []string) (map[string]int, error) {
	if r.patternIDs == nil {
		r.patternIDs = map[string]bool{}
		var list string
		if r.db.QueryRow("SELECT value FROM meta WHERE key='pattern_ids'").Scan(&list) == nil {
			var parsed []string
			_ = json.Unmarshal([]byte(list), &parsed)
			for _, id := range parsed {
				r.patternIDs[id] = true
			}
		}
	}
	counts := map[string]int{}
	var wanted []string
	for _, id := range ids {
		if r.patternIDs[id] {
			if _, dup := counts[id]; !dup {
				counts[id] = 0
				wanted = append(wanted, id)
			}
		}
	}
	if len(wanted) == 0 {
		return counts, nil
	}
	sort.Strings(wanted)
	rowsInScope, err := r.scoped(scope)
	if err != nil {
		return nil, err
	}
	files := map[string]int{}
	for _, row := range rowsInScope {
		if !row.why.Valid && row.hash.Valid {
			files[row.hash.String+":"+row.lang.String]++
		}
	}
	marks := make([]string, len(wanted))
	args := make([]any, len(wanted))
	for i, id := range wanted {
		marks[i] = "?" + strconvItoa(i+1)
		args[i] = id
	}
	in := strings.Join(marks, ",")
	rows, err := r.db.Query("SELECT hash,lang,pattern,count FROM main.counts WHERE pattern IN ("+in+") UNION SELECT hash,lang,pattern,count FROM base.counts WHERE pattern IN ("+in+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var hash, lang, pattern string
		var count int
		if err := rows.Scan(&hash, &lang, &pattern, &count); err != nil {
			return nil, err
		}
		if times := files[hash+":"+lang]; times > 0 {
			counts[pattern] += count * times
		}
	}
	return counts, rows.Err()
}

// Coverage says how many files are indexed, and why the others aren't, for
// one path or a glob.
func (r *Reader) Coverage(pathOrGlob string) (*CoverageAnswer, error) {
	var rows []pathRow
	if isLiteral(pathOrGlob) {
		if rel, ok := r.relative(pathOrGlob); ok {
			var row pathRow
			if r.db.QueryRow("SELECT path,hash,lang,is_test,mtime_ns,reason FROM paths WHERE path=?", rel).
				Scan(&row.path, &row.hash, &row.lang, &row.isTest, &row.mtime, &row.why) == nil {
				rows = append(rows, row)
			}
		}
	} else {
		var err error
		if rows, err = r.scoped(normalizeGlob(pathOrGlob)); err != nil {
			return nil, err
		}
	}
	answer := &CoverageAnswer{Files: len(rows), NotIndexed: map[string]int{}}
	shifted := map[string]bool{}
	if entries, err := os.ReadDir(filepath.Join(r.directory, "shifts", r.key)); err == nil {
		for _, entry := range entries {
			shifted[entry.Name()] = true
		}
	}
	for _, row := range rows {
		reason := ""
		if row.why.Valid {
			reason = row.why.String
		} else if shifted[place.ShortHash(row.path)] && shift.AnyUnknown(shift.Pending(r.directory, r.key, row.path, row.mtime)) {
			reason = "changed since the last parse"
		}
		if reason == "" {
			answer.Indexed++
		} else {
			answer.NotIndexed[reason]++
		}
	}
	return answer, nil
}
