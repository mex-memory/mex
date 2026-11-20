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
)

// definitionKinds are the nodes a name can resolve to: things that are
// defined and used, not files, imports or parameters.
const definitionKinds = `'class','struct','interface','trait','protocol','function','method',` +
	`'constant','enum','type_alias','namespace','component','route','variable'`

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
// immutable: no locks and no waiting on a writer.
type Store struct {
	db      *sql.DB
	pointer pointer
	// tests marks test files; the file index knows them, the graph doesn't.
	isTest func(path string) bool
}

// OpenStore opens the graph the checkout's pointer names. isTest may be nil,
// in which case no test is ever found.
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
		isTest = func(string) bool { return false }
	}
	return &Store{db: db, pointer: p, isTest: isTest}, nil
}

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
	var hash string
	if err := s.db.QueryRow("SELECT content_hash FROM files WHERE path=?", path).Scan(&hash); err != nil || len(hash) < 32 {
		return "", false
	}
	return hash[:32], true
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

// Resolve finds the definitions a plain name names, nearest file first.
func (s *Store) Resolve(name string) ([]Symbol, error) {
	rows, err := s.db.Query(`SELECT `+symbolColumns+` FROM nodes n
		WHERE n.name=? AND n.kind IN (`+definitionKinds+`) ORDER BY n.file_path, n.start_line LIMIT 50`, name)
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

// Node is one symbol by id.
func (s *Store) Node(id string) (Symbol, bool) {
	sym, err := scanSymbol(s.db.QueryRow(`SELECT `+symbolColumns+` FROM nodes n WHERE n.id=?`, id).Scan)
	return sym, err == nil
}

// Callers are the uses of a symbol: real calls, and the symbol passed as a
// value (a callback), kept apart. Each site is where the use is and the
// symbol it's inside.
func (s *Store) Callers(id string) ([]Site, error) {
	return s.sites(`SELECT `+symbolColumns+`, coalesce(e.line, n.start_line), e.kind FROM edges e
		JOIN nodes n ON n.id = e.source
		WHERE e.target=? AND e.kind IN ('calls','references') AND e.source <> e.target
		ORDER BY n.file_path, e.line LIMIT 500`, id, true)
}

// Callees are what a symbol calls or passes on. Each site is the call's line
// in the symbol, and the symbol called.
func (s *Store) Callees(id string) ([]Site, error) {
	return s.sites(`SELECT `+symbolColumns+`, coalesce(e.line, 0), e.kind FROM edges e
		JOIN nodes n ON n.id = e.target
		WHERE e.source=? AND e.kind IN ('calls','references') AND e.source <> e.target
		ORDER BY e.line, n.name LIMIT 500`, id, false)
}

func (s *Store) sites(query, id string, callers bool) ([]Site, error) {
	var from Symbol
	if !callers {
		var ok bool
		if from, ok = s.Node(id); !ok {
			return nil, nil
		}
	}
	rows, err := s.db.Query(query, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	var out []Site
	for rows.Next() {
		var sym Symbol
		var exported, line int
		var kind string
		if err := rows.Scan(&sym.ID, &sym.Name, &sym.Path, &sym.Start, &sym.End, &sym.Kind, &exported,
			&sym.Signature, &sym.Hash, &line, &kind); err != nil {
			return nil, err
		}
		sym.Exported = exported != 0
		site := Site{Path: sym.Path, Line: line, In: sym, Kind: Call}
		if kind == "references" {
			site.Kind = Value
		}
		if !callers {
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
	return out, rows.Err()
}

// Tests are the tests that cover a symbol: a test that calls it directly, or
// one that reaches it only through a caller it tests.
func (s *Store) Tests(id string) ([]TestLink, error) {
	callers, err := s.Callers(id)
	if err != nil {
		return nil, err
	}
	var out []TestLink
	seen := map[string]bool{}
	var tested []Site
	for _, c := range callers {
		if c.Kind != Call {
			continue
		}
		if s.isTest(c.Path) {
			if !seen[c.In.ID] {
				seen[c.In.ID] = true
				out = append(out, TestLink{Test: c.In, Reach: Direct})
			}
			continue
		}
		tested = append(tested, c)
	}
	for _, c := range tested {
		upper, err := s.Callers(c.In.ID)
		if err != nil {
			return nil, err
		}
		for _, u := range upper {
			if u.Kind == Call && s.isTest(u.Path) && !seen[u.In.ID] {
				seen[u.In.ID] = true
				out = append(out, TestLink{Test: u.In, Reach: ViaCaller})
			}
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
	if err := s.db.QueryRow(`SELECT count(*) FROM unresolved_refs
		WHERE reference_name=? AND status IN ('pending','ambiguous','unresolved')`, sym.Name).Scan(&n); err != nil {
		return 0
	}
	return n
}

// Complete reports that the graph indexed every file it saw: nothing too
// big, unreadable or failed to parse. Only then is "no callers" true.
func (s *Store) Complete() bool {
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM coverage").Scan(&n); err != nil {
		// A graph without the table predates coverage: say nothing is complete.
		return false
	}
	return n == 0
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

// CallsBetween counts resolved calls from code in files from accepts into
// code in files to accepts, with the first one found (in path and line
// order) for the reason. Complete reports that every file is indexed, so a
// count lower than expected is proof and not a gap.
func (s *Store) CallsBetween(from, to func(path string) bool) (n int, fromPath, toPath string, line int, complete bool, err error) {
	rows, err := s.db.Query(`SELECT s.file_path, t.file_path, e.line FROM edges e
		JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
		WHERE e.kind='calls' ORDER BY s.file_path, e.line`)
	if err != nil {
		return 0, "", "", 0, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var src, dst string
		var at sql.NullInt64
		if err := rows.Scan(&src, &dst, &at); err != nil {
			return 0, "", "", 0, false, err
		}
		if !from(src) || !to(dst) {
			continue
		}
		if n == 0 {
			fromPath, toPath, line = src, dst, int(at.Int64)
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return 0, "", "", 0, false, err
	}
	return n, fromPath, toPath, line, s.Complete(), nil
}
