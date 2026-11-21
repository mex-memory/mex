package graph

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/record/place"
	_ "modernc.org/sqlite"
)

// ErrNoGraph means the checkout has no published graph; callers stay silent.
var ErrNoGraph = errors.New("no graph for this checkout")

// Published names, as the Node writer names them (src/graph/storage.ts, overlay.ts).
var (
	baseName    = regexp.MustCompile(`^graph-base-[a-z0-9-]+\.db$`)
	overlayName = regexp.MustCompile(`^graph-o-[a-f0-9]{24}-[a-z0-9-]+\.db$`)
	fileLike    = regexp.MustCompile(`[/\\]|\.[A-Za-z0-9]{1,6}$`)
)

// definitionKinds are the nodes a name can resolve to: things that are
// defined and used, not files, imports or parameters.
const definitionKinds = `'class','struct','interface','trait','protocol','function','method',` +
	`'constant','enum','type_alias','namespace','component','route','variable'`

// ownerDepth bounds the walk from an anonymous callback to its named owner.
const ownerDepth = 12

// pointer is the checkout's graph pointer (graph-checkouts/<key>.json).
type pointer struct {
	Version int     `json:"version"`
	Root    string  `json:"root"`
	Base    string  `json:"base"`
	Overlay *string `json:"overlay"`
	AsOf    string  `json:"as_of"`
	Head    *string `json:"head"`
}

// Store reads a checkout's published graph: its base, plus its overlay when
// it has one, seen as one graph. Published files never change, so they open
// immutable: no locks and no waiting on a writer. A Store answers one request
// and caches what it reads; it isn't shared across goroutines.
type Store struct {
	db      *sql.DB
	pointer pointer
	// isTest marks test files; the file index knows them, the graph doesn't.
	isTest   func(path string) bool
	tests    map[string]bool
	owners   map[string]*Symbol
	complete *bool
	built    map[string]string
	hashes   map[string]string
}

// OpenStore opens the graph the checkout's pointer names. isTest may be nil,
// in which case test files are told by their path alone.
func OpenStore(recordDirectory, projectID, checkout string, isTest func(string) bool) (*Store, error) {
	root, err := place.RealPath(checkout)
	if err != nil {
		return nil, err
	}
	key := place.ShortHash(root)
	directory := index.Directory(recordDirectory, projectID)
	data, err := os.ReadFile(filepath.Join(directory, "graph-checkouts", key+".json"))
	if err != nil || len(data) > 64*1024 {
		return nil, ErrNoGraph
	}
	var p pointer
	if json.Unmarshal(data, &p) != nil || p.Version != 1 || p.Root != root || !baseName.MatchString(p.Base) {
		return nil, ErrNoGraph
	}
	main := p.Base
	if p.Overlay != nil {
		if !overlayName.MatchString(*p.Overlay) || !strings.HasPrefix(*p.Overlay, "graph-o-"+key+"-") {
			return nil, ErrNoGraph
		}
		main = *p.Overlay
	}
	db, err := sql.Open("sqlite", immutableURI(filepath.Join(directory, main)))
	if err != nil {
		return nil, err
	}
	// One connection: the TEMP views below live on it.
	db.SetMaxOpenConns(1)
	if p.Overlay != nil {
		if err := installViews(db, filepath.Join(directory, p.Base)); err != nil {
			db.Close()
			return nil, err
		}
	} else if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if isTest == nil {
		isTest = TestPath
	}
	return &Store{db: db, pointer: p, isTest: isTest, tests: map[string]bool{}, owners: map[string]*Symbol{}, hashes: map[string]string{}}, nil
}

// testDirectory and testFile tell a test file by its path, as the file index
// does (src/file-index/classify.ts), for reads without a file index.
var (
	testDirectory = regexp.MustCompile(`(?i)(^|/)(__tests__|__test__|tests?|specs?|e2e|cypress)/`)
	testFile      = regexp.MustCompile(`(?i)\.(test|spec|e2e-spec|e2e)\.[cm]?[jt]sx?$|(^|/)test_[^/]*\.pyi?$|_tests?\.pyi?$|(^|/)conftest\.py$|(^|/)tests?\.rs$|_tests?\.rs$|tests?\.cs$|_test\.go$`)
)

// TestPath tells a test file by its path alone.
func TestPath(path string) bool { return testDirectory.MatchString(path) || testFile.MatchString(path) }

func immutableURI(file string) string {
	slash := filepath.ToSlash(file)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	u := url.URL{Scheme: "file", Path: slash, RawQuery: "mode=ro&immutable=1"}
	return u.String()
}

// installViews makes the overlay connection read the union with its base,
// as Node's installGraphViews does: base rows of files the overlay doesn't
// shadow, plus the overlay's rows. Only the tables reads use are viewed.
func installViews(db *sql.DB, base string) error {
	var named string
	if err := db.QueryRow("SELECT value FROM main.overlay_info WHERE key='base'").Scan(&named); err != nil {
		return err
	}
	if named != filepath.Base(base) {
		return ErrNoGraph
	}
	if _, err := db.Exec("ATTACH DATABASE ? AS base", immutableURI(base)); err != nil {
		return err
	}
	views := []struct{ table, column, shadow string }{
		{"nodes", "file_path", "SELECT path FROM main.shadow_files"},
		{"edges", "source", "SELECT id FROM main.shadow_nodes"},
		{"files", "path", "SELECT path FROM main.shadow_files"},
		{"coverage", "path", "SELECT path FROM main.shadow_files"},
		{"unresolved_refs", "from_node_id", "SELECT id FROM main.shadow_nodes"},
	}
	for _, v := range views {
		var present int
		if err := db.QueryRow("SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name=?", v.table).Scan(&present); err != nil {
			return err
		}
		if present == 0 {
			continue
		}
		if _, err := db.Exec(`CREATE TEMP VIEW ` + v.table + ` AS
			SELECT * FROM base.` + v.table + ` WHERE ` + v.column + ` NOT IN (` + v.shadow + `)
			UNION ALL SELECT * FROM main.` + v.table); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

// AsOf is when the graph this answer comes from was built.
func (s *Store) AsOf() string { return s.pointer.AsOf }

// BuiltHash is the hash a file had when the graph was built, in the file
// index's form (the first 32 hex digits of the same SHA-256), so the two
// compare directly.
func (s *Store) BuiltHash(path string) (string, bool) {
	if s.built != nil {
		h, ok := s.built[path]
		return h, ok
	}
	if h, ok := s.hashes[path]; ok {
		return h, h != ""
	}
	var hash string
	if err := s.db.QueryRow("SELECT content_hash FROM files WHERE path=?", path).Scan(&hash); err != nil || len(hash) < 32 {
		s.hashes[path] = ""
		return "", false
	}
	s.hashes[path] = hash[:32]
	return hash[:32], true
}

// BuiltFiles is every file the graph holds, with its hash at build.
func (s *Store) BuiltFiles() map[string]string {
	if s.built != nil {
		return s.built
	}
	out := map[string]string{}
	rows, err := s.db.Query("SELECT path, content_hash FROM files")
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var path, hash string
		if rows.Scan(&path, &hash) == nil && len(hash) >= 32 {
			out[path] = hash[:32]
		}
	}
	if rows.Err() == nil {
		s.built = out
	}
	return out
}

const symbolColumns = `n.id, n.name, n.file_path, n.start_line, n.end_line, n.kind,
	coalesce(n.is_exported,0), coalesce(n.signature,''), coalesce(n.body_hash,'')`

func scanSymbol(scan func(...any) error) (Symbol, error) {
	var s Symbol
	var exported int
	err := scan(&s.ID, &s.Name, &s.Path, &s.Start, &s.End, &s.Kind, &exported, &s.Signature, &s.Hash)
	s.Exported = exported != 0
	return s, err
}

// Query is a definition a person or a search names: a name, optionally with
// the file it's in and the definitions around it.
type Query struct {
	File, Owner, Name string
}

// ParseQuery reads "name", "Owner.name" or "Owner::name", and any of those
// after "path/to/file.ts:".
func ParseQuery(q string) Query {
	q = strings.TrimSpace(q)
	var out Query
	if i := lastSingleColon(q); i > 0 && fileLike.MatchString(q[:i]) {
		out.File, q = filepath.ToSlash(strings.TrimPrefix(q[:i], "./")), q[i+1:]
	}
	switch {
	case strings.Contains(q, "::"):
		i := strings.LastIndex(q, "::")
		out.Owner, out.Name = q[:i], q[i+2:]
	case strings.Contains(q, "."):
		i := strings.LastIndex(q, ".")
		out.Owner, out.Name = strings.ReplaceAll(q[:i], ".", "::"), q[i+1:]
	default:
		out.Name = q
	}
	return out
}

// lastSingleColon is the last ':' that isn't part of "::".
func lastSingleColon(q string) int {
	for i := len(q) - 1; i > 0; i-- {
		if q[i] != ':' {
			continue
		}
		if q[i-1] == ':' {
			i--
			continue
		}
		if i+1 < len(q) && q[i+1] == ':' {
			continue
		}
		return i
	}
	return -1
}

// Resolve finds the definitions a query names, in path and line order.
func (s *Store) Resolve(query string) ([]Symbol, error) {
	q := ParseQuery(query)
	if q.Name == "" {
		return nil, nil
	}
	where, args := `n.name=? AND n.kind IN (`+definitionKinds+`)`, []any{q.Name}
	if q.File != "" {
		where += ` AND (n.file_path=? OR n.file_path LIKE ? ESCAPE '\')`
		args = append(args, q.File, "%/"+likeEscape(q.File))
	}
	if q.Owner != "" {
		full := q.Owner + "::" + q.Name
		where += ` AND (n.qualified_name=? OR n.qualified_name LIKE ? ESCAPE '\')`
		args = append(args, full, "%::"+likeEscape(full))
	}
	rows, err := s.db.Query(`SELECT `+symbolColumns+` FROM nodes n WHERE `+where+` ORDER BY n.file_path, n.start_line LIMIT 50`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Symbol
	for rows.Next() {
		sym, err := scanSymbol(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, sym)
	}
	return out, rows.Err()
}

// Declared is every definition in one file, as built, in line order: what
// an edit to the file can be inside of, after the file index has let go of
// the lines it changed.
func (s *Store) Declared(path string) ([]Symbol, error) {
	rows, err := s.db.Query(`SELECT `+symbolColumns+` FROM nodes n WHERE n.file_path=? AND n.kind IN (`+definitionKinds+`) ORDER BY n.start_line LIMIT 500`, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Symbol
	for rows.Next() {
		sym, err := scanSymbol(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, sym)
	}
	return out, rows.Err()
}

// Declarer is the optional part of a Reader that lists a file's definitions.
type Declarer interface {
	Declared(path string) ([]Symbol, error)
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// Selector is the shortest query that names this definition alone among
// matches: its owner and name when that's enough, else its file and name.
func (s *Store) Selector(sym Symbol, matches []Symbol) string {
	var qualified string
	if s.db.QueryRow("SELECT coalesce(qualified_name,'') FROM nodes WHERE id=?", sym.ID).Scan(&qualified) == nil && strings.Contains(qualified, "::") {
		dotted := strings.ReplaceAll(qualified, "::", ".")
		if !strings.Contains(dotted, "<") {
			n := 0
			for _, m := range matches {
				var other string
				if s.db.QueryRow("SELECT coalesce(qualified_name,'') FROM nodes WHERE id=?", m.ID).Scan(&other) == nil && other == qualified {
					n++
				}
			}
			if n == 1 {
				return dotted
			}
		}
	}
	n := 0
	for _, m := range matches {
		if m.Path == sym.Path {
			n++
		}
	}
	if n == 1 {
		return sym.Path + ":" + sym.Name
	}
	// Several in one file: its file and its owner.
	if qualified != "" && strings.Contains(qualified, "::") && !strings.Contains(qualified, "<") {
		same := 0
		for _, m := range matches {
			var other string
			if m.Path == sym.Path && s.db.QueryRow("SELECT coalesce(qualified_name,'') FROM nodes WHERE id=?", m.ID).Scan(&other) == nil && other == qualified {
				same++
			}
		}
		if same == 1 {
			return sym.Path + ":" + strings.ReplaceAll(qualified, "::", ".")
		}
	}
	return ""
}

// Preferred is the definition a query without an owner means among several:
// the one defined at the top of its file (`createMiddleware`, not the
// `Factory.createMiddleware` method beside it), else the one that isn't a
// bodiless member of an interface or type. Cards never use it: a card needs
// a name that names one place.
func (s *Store) Preferred(defs []Symbol, q Query) (Symbol, bool) {
	if q.Owner != "" || len(defs) < 2 {
		return Symbol{}, false
	}
	var top, bodied []Symbol
	for _, d := range defs {
		var qualified, container string
		if s.db.QueryRow(`SELECT coalesce(n.qualified_name,''), coalesce(c.kind,'') FROM nodes n
			LEFT JOIN nodes c ON c.id = n.container_id WHERE n.id=?`, d.ID).Scan(&qualified, &container) != nil {
			return Symbol{}, false
		}
		if !strings.Contains(qualified, "::") {
			top = append(top, d)
		}
		if container != "interface" && container != "type_alias" {
			bodied = append(bodied, d)
		}
	}
	switch {
	case len(top) == 1:
		return top[0], true
	case len(bodied) == 1:
		return bodied[0], true
	}
	return Symbol{}, false
}

// Node is one symbol by id.
func (s *Store) Node(id string) (Symbol, bool) {
	sym, err := scanSymbol(s.db.QueryRow(`SELECT `+symbolColumns+` FROM nodes n WHERE n.id=?`, id).Scan)
	return sym, err == nil
}

// owner is the nearest named definition around an anonymous one, or nil.
func (s *Store) owner(sym Symbol) *Symbol {
	if !Anonymous(sym) {
		return nil
	}
	if o, ok := s.owners[sym.ID]; ok {
		return o
	}
	var found *Symbol
	id := sym.ID
	for depth := 0; depth < ownerDepth; depth++ {
		var parent sql.NullString
		if s.db.QueryRow("SELECT container_id FROM nodes WHERE id=?", id).Scan(&parent) != nil || !parent.Valid || parent.String == "" {
			break
		}
		p, ok := s.Node(parent.String)
		if !ok || p.Kind == "file" {
			break
		}
		if !Anonymous(p) {
			found = &p
			break
		}
		id = p.ID
	}
	s.owners[sym.ID] = found
	return found
}

func (s *Store) test(path string) bool {
	if t, ok := s.tests[path]; ok {
		return t
	}
	t := s.isTest(path)
	s.tests[path] = t
	return t
}

// Callers are the uses of a symbol: real calls, and the symbol passed as a
// value (a callback), kept apart. Each site is where the use is and the
// definition it's inside; a recursive call is a site inside the symbol itself.
//
// A call through an interface or a union whose one candidate in the graph is
// this symbol is a call to it too: the extractor keeps such calls apart as
// "ambiguous", since the type could have other implementations, but this is
// the only one the graph holds. Those sites are marked Through.
func (s *Store) Callers(id string) ([]Site, error) {
	var name string
	if s.db.QueryRow("SELECT name FROM nodes WHERE id=?", id).Scan(&name) != nil {
		return nil, nil
	}
	// By name first: unresolved_refs is indexed on the name, not the candidates.
	return s.sites(`SELECT * FROM (
		SELECT `+symbolColumns+`, coalesce(e.line, n.start_line), e.kind, 0 FROM edges e
		JOIN nodes n ON n.id = e.source
		WHERE e.target=?1 AND e.kind IN ('calls','references')
		UNION ALL
		SELECT `+symbolColumns+`, u.line, 'calls', 1 FROM unresolved_refs u
		JOIN nodes n ON n.id = u.from_node_id
		WHERE u.reference_name=?2 AND u.status='ambiguous' AND u.reference_kind='calls' AND u.candidates = '["' || ?1 || '"]'
	) ORDER BY 3, 10 LIMIT 500`, []any{id, name}, nil)
}

// within is the definition and everything nested in it.
const within = `WITH RECURSIVE inner(id) AS (SELECT ?1 UNION SELECT n.id FROM nodes n JOIN inner ON n.container_id = inner.id) `

// Callees are what a definition calls or passes on, from its own body and
// the functions and callbacks nested in it; calls into those are its own
// workings and are left out. Each site is the call's line, and the
// definition called.
func (s *Store) Callees(id string) ([]Site, error) {
	from, ok := s.Node(id)
	if !ok {
		return nil, nil
	}
	return s.sites(within+`SELECT * FROM (
		SELECT `+symbolColumns+`, coalesce(e.line, 0), e.kind, 0 FROM edges e
		JOIN nodes n ON n.id = e.target
		WHERE e.source IN (SELECT id FROM inner) AND e.target NOT IN (SELECT id FROM inner)
		AND e.kind IN ('calls','references')
		UNION ALL
		SELECT `+symbolColumns+`, u.line, 'calls', 1 FROM unresolved_refs u
		JOIN nodes n ON n.id = json_extract(u.candidates, '$[0]')
		WHERE u.from_node_id IN (SELECT id FROM inner) AND u.status='ambiguous' AND u.reference_kind='calls'
		AND json_array_length(u.candidates) = 1 AND n.id NOT IN (SELECT id FROM inner)
	) ORDER BY 10, 2 LIMIT 500`, []any{id}, &from)
}

func (s *Store) sites(query string, args []any, from *Symbol) ([]Site, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	var out []Site
	seen := map[string]bool{}
	for rows.Next() {
		var sym Symbol
		var exported, line, through int
		var kind string
		if err := rows.Scan(&sym.ID, &sym.Name, &sym.Path, &sym.Start, &sym.End, &sym.Kind, &exported,
			&sym.Signature, &sym.Hash, &line, &kind, &through); err != nil {
			rows.Close()
			return nil, err
		}
		sym.Exported = exported != 0
		site := Site{Path: sym.Path, Line: line, In: sym, Kind: Call, Through: through != 0}
		if kind == "references" {
			site.Kind = Value
		}
		if from != nil {
			site.Path = from.Path
			if line == 0 {
				site.Line = from.Start
			}
		}
		k := site.In.ID + "\x00" + string(site.Kind) + "\x00" + site.Path + "\x00" + itoa(site.Line)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, site)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if from == nil {
		// Owners are read after the rows are closed: the store has one connection.
		for i := range out {
			out[i].Owner = s.owner(out[i].In)
		}
	}
	return out, nil
}

// Tests are the tests that cover a symbol: a test that calls it directly, or
// one that reaches it only through a caller it tests. Two queries, whatever
// the number of callers.
func (s *Store) Tests(id string) ([]TestLink, error) {
	callers, err := s.Callers(id)
	if err != nil {
		return nil, err
	}
	var out []TestLink
	seen := map[string]bool{}
	var through []any
	asked := map[string]bool{}
	for _, c := range callers {
		if c.Kind != Call {
			continue
		}
		if s.test(c.Path) {
			if !seen[c.In.ID] {
				seen[c.In.ID] = true
				out = append(out, TestLink{Test: c.In, Line: c.Line, Reach: Direct})
			}
			continue
		}
		// Tests call the named definition a callback is passed in, never the callback.
		named := c.Named()
		if named.ID != id && !asked[named.ID] {
			asked[named.ID] = true
			through = append(through, named.ID)
		}
	}
	if len(through) == 0 {
		return out, nil
	}
	if len(through) > 200 {
		through = through[:200]
	}
	rows, err := s.db.Query(`SELECT `+symbolColumns+`, coalesce(e.line, n.start_line), coalesce(callee.name, '') FROM edges e
		JOIN nodes n ON n.id = e.source
		LEFT JOIN nodes callee ON callee.id = e.target
		WHERE e.target IN (?`+strings.Repeat(",?", len(through)-1)+`) AND e.kind='calls'
		ORDER BY n.file_path, e.line LIMIT 500`, through...)
	if err != nil {
		return nil, err
	}
	var via []TestLink
	for rows.Next() {
		var line int
		var exported int
		var sym Symbol
		var callee string
		if err := rows.Scan(&sym.ID, &sym.Name, &sym.Path, &sym.Start, &sym.End, &sym.Kind, &exported, &sym.Signature, &sym.Hash, &line, &callee); err != nil {
			rows.Close()
			return nil, err
		}
		sym.Exported = exported != 0
		via = append(via, TestLink{Test: sym, Line: line, Reach: ViaCaller, Via: callee})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, t := range via {
		if !seen[t.Test.ID] && s.test(t.Test.Path) {
			seen[t.Test.ID] = true
			out = append(out, t)
		}
	}
	return out, nil
}

// Unresolved counts dynamic uses of the symbol's name the graph couldn't tie
// to a definition: they may be callers the graph doesn't show.
func (s *Store) Unresolved(id string) int {
	sym, ok := s.Node(id)
	if !ok {
		return 0
	}
	var n int
	// A call whose one candidate is this symbol is shown as a caller, not counted here.
	if err := s.db.QueryRow(`SELECT count(*) FROM unresolved_refs
		WHERE reference_name=?1 AND status IN ('pending','ambiguous','unresolved')
		AND coalesce(candidates,'') <> '["' || ?2 || '"]'`, sym.Name, id).Scan(&n); err != nil {
		return 0
	}
	return n
}

// UnresolvedIn counts calls from inside a definition that the graph couldn't
// resolve: callees it may not show.
func (s *Store) UnresolvedIn(id string) int {
	var n int
	if err := s.db.QueryRow(within+`SELECT count(*) FROM unresolved_refs
		WHERE from_node_id IN (SELECT id FROM inner) AND status IN ('pending','ambiguous','unresolved')
		AND NOT (status='ambiguous' AND reference_kind='calls' AND json_valid(candidates) AND json_array_length(candidates) = 1)`, id).Scan(&n); err != nil {
		return 0
	}
	return n
}

// Complete reports that the graph indexed every file it saw: nothing too
// big, unreadable or failed to parse.
func (s *Store) Complete() bool {
	if s.complete != nil {
		return *s.complete
	}
	var n int
	// A graph without the table predates coverage: say nothing is complete.
	complete := s.db.QueryRow("SELECT count(*) FROM coverage").Scan(&n) == nil && n == 0
	s.complete = &complete
	return complete
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

var _ Reader = (*Store)(nil)

// GlobPrefix is the literal start of a path glob: the folder every match
// is under, or the whole path when it has no wildcard.
func GlobPrefix(glob string) string {
	i := strings.IndexAny(glob, "*?[{")
	if i < 0 {
		return glob
	}
	return glob[:strings.LastIndex(glob[:i], "/")+1]
}

// CallsBetween counts resolved calls from code in files from accepts into
// code in files to accepts, with the first one found (in path and line
// order) for the reason. fromPrefix and toPrefix narrow the read to the
// files under them, so only those scopes' calls are read. A call through an
// interface whose one candidate is in the to scope counts, as it does for
// callers. Complete reports that every file is indexed, so a count lower
// than expected is proof and not a gap.
func (s *Store) CallsBetween(fromPrefix, toPrefix string, from, to func(path string) bool) (n int, fromPath, toPath string, line int, complete bool, err error) {
	rows, err := s.db.Query(`SELECT * FROM (
		SELECT src.file_path, dst.file_path, coalesce(e.line, 0) FROM nodes src
		CROSS JOIN edges e ON e.source = src.id AND e.kind = 'calls'
		CROSS JOIN nodes dst ON dst.id = e.target
		WHERE src.file_path >= ?1 AND src.file_path < ?1 || char(1114111)
		AND dst.file_path >= ?2 AND dst.file_path < ?2 || char(1114111) AND src.file_path <> dst.file_path
		UNION ALL
		SELECT src.file_path, dst.file_path, u.line FROM unresolved_refs u
		JOIN nodes src ON src.id = u.from_node_id
		JOIN nodes dst ON dst.id = json_extract(u.candidates, '$[0]')
		WHERE u.file_path >= ?1 AND u.file_path < ?1 || char(1114111)
		AND u.status = 'ambiguous' AND u.reference_kind = 'calls' AND json_valid(u.candidates) AND json_array_length(u.candidates) = 1
		AND dst.file_path >= ?2 AND dst.file_path < ?2 || char(1114111) AND src.file_path <> dst.file_path
	) ORDER BY 1, 3`, fromPrefix, toPrefix)
	if err != nil {
		return 0, "", "", 0, false, err
	}
	for rows.Next() {
		var src, dst string
		var at int
		if err := rows.Scan(&src, &dst, &at); err != nil {
			rows.Close()
			return 0, "", "", 0, false, err
		}
		if !from(src) || !to(dst) {
			continue
		}
		if n == 0 {
			fromPath, toPath, line = src, dst, at
		}
		n++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, "", "", 0, false, err
	}
	return n, fromPath, toPath, line, s.Complete(), nil
}
