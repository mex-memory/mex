package graph

import (
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"strings"
)

const v5SchemaVersion = 5

func installV5Views(db *sql.DB, file, base string, overlay bool) error {
	if info, err := os.Lstat(file); err != nil || !info.Mode().IsRegular() {
		return ErrNoGraph
	}
	fileNodes := `SELECT n.*, f.path FROM main.nodes n JOIN main.files f ON f.id=n.file`
	if overlay {
		if err := installV5Overlay(db, base); err != nil {
			return err
		}
		fileNodes += ` UNION ALL
			SELECT n.*, f.path FROM base.nodes n JOIN base.files f ON f.id=n.file
			WHERE n.file NOT IN (SELECT id FROM temp.v5_shadowed_files)`
	} else if err := requireV5Base(db, "main"); err != nil {
		return err
	}
	// A live node and its file are always on the same side. Joining before
	// the union lets SQLite use nodes_name for Resolve and files.path and
	// nodes_file_line for Declared.
	_, err := db.Exec("CREATE TEMP VIEW v5_file_nodes AS " + fileNodes)
	return err
}

func requireV5Base(db *sql.DB, schema string) error {
	var overlay bool
	if err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM " + schema + ".sqlite_schema WHERE type='table' AND name='overlay_info')").Scan(&overlay); err != nil {
		return err
	}
	if overlay {
		return ErrNoGraph
	}
	return nil
}

func immutableBaseInfo(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrNoGraph
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(path + suffix); !os.IsNotExist(err) {
			return nil, ErrNoGraph
		}
	}
	return info, nil
}

func installV5Overlay(db *sql.DB, base string) error {
	before, err := immutableBaseInfo(base)
	if err != nil {
		return err
	}
	if err := attachOverlayBase(db, base); err != nil {
		return err
	}
	var version int
	if err := db.QueryRow("PRAGMA base.user_version").Scan(&version); err != nil {
		return err
	}
	if version != v5SchemaVersion {
		return ErrNoGraph
	}
	if err := requireV5Base(db, "base"); err != nil {
		return err
	}
	after, err := immutableBaseInfo(base)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return ErrNoGraph
	}
	// Shadow by path, including tombstones. Edges and unresolved rows
	// belong to their source node, even when their target is on the other
	// side. An unshadowed source can still refer to a surviving node by key.
	if _, err := db.Exec(`CREATE TEMP VIEW v5_shadowed_files AS
		SELECT f.id FROM main.shadow_files s CROSS JOIN base.files f ON f.path=s.path;
		CREATE TEMP VIEW v5_shadowed_nodes AS
		SELECT n.id FROM temp.v5_shadowed_files f CROSS JOIN base.nodes n ON n.file=f.id;`); err != nil {
		return err
	}
	for _, v := range []struct{ table, key, owner string }{
		{"files", "id", "files"}, {"nodes", "file", "files"},
		{"edges", "source", "nodes"}, {"unresolved_calls", "source", "nodes"}, {"unresolved_other", "source", "nodes"},
	} {
		if _, err := db.Exec("CREATE TEMP VIEW " + v.table + " AS SELECT * FROM main." + v.table +
			" UNION ALL SELECT * FROM base." + v.table + " WHERE " + v.key +
			" NOT IN (SELECT id FROM temp.v5_shadowed_" + v.owner + ")"); err != nil {
			return err
		}
	}
	// The writer keeps base codes and only adds new ones to the overlay.
	// Coverage is checkout-wide in v5, so reads use main.coverage directly.
	for _, table := range []string{"node_kinds", "edge_kinds", "unresolved_names", "resolution_methods"} {
		if _, err := db.Exec("CREATE TEMP VIEW " + table + " AS SELECT * FROM main." + table +
			" UNION ALL SELECT * FROM base." + table); err != nil {
			return err
		}
	}
	return nil
}

const v5NodeKind = "(SELECT name FROM node_kinds WHERE id=n.kind)"
const v5SymbolColumns = v5NodeKind + ` || ':' || lower(hex(n.public_id)), n.name, n.path, n.start_line, n.end_line, ` +
	v5NodeKind + `, n.flags & 1, coalesce(n.signature,''), lower(hex(n.body_hash))`
const v5SelectSymbol = "SELECT " + v5SymbolColumns + " FROM temp.v5_file_nodes n"
const v5PublicIDWhere = "n.public_id=? AND n.kind=(SELECT id FROM node_kinds WHERE name=?)"

const v5PreferredDetails = `SELECT n.qualified_name, coalesce(
	(SELECT name FROM node_kinds WHERE id=(SELECT kind FROM nodes WHERE id=n.parent)), '')
	FROM nodes n WHERE ` + v5PublicIDWhere

func v5IDArgs(id string) []any {
	kind, digest, _ := strings.Cut(id, ":")
	return []any{v5PublicDigest(digest), kind}
}

func v5PublicDigest(digest string) []byte {
	if len(digest) != 32 || strings.ContainsAny(digest, "ABCDEF") {
		return nil
	}
	data, err := hex.DecodeString(digest)
	if err != nil {
		return nil
	}
	return data
}

func (s *Store) nodeRow(id, v4Query, v5Query string) *sql.Row {
	if s.v5 {
		return s.db.QueryRow(v5Query, v5IDArgs(id)...)
	}
	return s.db.QueryRow(v4Query, id)
}

const v5CallKind = "(SELECT id FROM edge_kinds WHERE name='calls')"
const v5UseKinds = "(SELECT id FROM edge_kinds WHERE name IN ('calls','references'))"
const v5ResolvedEdge = "method IS NOT (SELECT id FROM resolution_methods WHERE name='basic')"

// Restrict the live union to the integer keys in the site's working set.
// Without the IN predicate, SQLite can materialize all v5_file_nodes before
// joining an overlay's symbol rows to an indexed edge lookup.
const v5SiteNodes = ` FROM temp.v5_file_nodes n CROSS JOIN uses u ON u.node=n.id
	WHERE n.id IN (SELECT node FROM uses)`

const v5Callers = `WITH uses(node, line, kind, through) AS MATERIALIZED (
		SELECT source, line, kind, 0 FROM edges WHERE target=?1 AND kind IN ` + v5UseKinds + ` AND ` + v5ResolvedEdge + `
		UNION ALL
		SELECT source, line, kind, 1 FROM unresolved_calls WHERE candidate=?1 AND kind=` + v5CallKind + `
	)
	SELECT ` + v5SymbolColumns + `, coalesce(nullif(u.line,-1),n.start_line),
		(SELECT name FROM edge_kinds WHERE id=u.kind), u.through` + v5SiteNodes + ` ORDER BY 3, 10 LIMIT 500`

func (s *Store) v5Callers(id string) ([]Site, error) {
	var key int64
	err := s.db.QueryRow("SELECT n.id FROM nodes n WHERE "+v5PublicIDWhere, v5IDArgs(id)...).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.sites(v5Callers, []any{key}, nil)
}

// Traverse each physical nodes_parent index. Joining the recursive term to
// the live nodes view can materialize every node to build a parent index.
func (s *Store) v5Within() string {
	query := `WITH RECURSIVE inner(id) AS (
		SELECT n.id FROM nodes n WHERE ` + v5PublicIDWhere + `
		UNION SELECT n.id FROM inner CROSS JOIN main.nodes n ON n.parent=inner.id`
	if s.pointer.Overlay != nil {
		query += `
		UNION SELECT n.id FROM inner CROSS JOIN base.nodes n ON n.parent=inner.id
		WHERE n.file NOT IN (SELECT id FROM temp.v5_shadowed_files)`
	}
	return query + ") "
}

func (s *Store) v5Callees(from Symbol) ([]Site, error) {
	return s.sites(s.v5Within()+`, uses(node, line, kind, through) AS MATERIALIZED (
		SELECT target, line, kind, 0 FROM edges
		WHERE source IN (SELECT id FROM inner) AND target NOT IN (SELECT id FROM inner)
		AND kind IN `+v5UseKinds+` AND `+v5ResolvedEdge+`
		UNION ALL
		SELECT candidate, line, kind, 1 FROM unresolved_calls
		WHERE source IN (SELECT id FROM inner) AND candidate NOT IN (SELECT id FROM inner)
		AND kind=`+v5CallKind+`
	)
	SELECT `+v5SymbolColumns+`, coalesce(nullif(u.line,-1),0),
		(SELECT name FROM edge_kinds WHERE id=u.kind), u.through`+v5SiteNodes+` ORDER BY 10, 2 LIMIT 500`, v5IDArgs(from.ID), &from)
}

func v5Tests(targets string) string {
	return `WITH uses(node, target, line) AS MATERIALIZED (
		SELECT source, target, line FROM edges WHERE kind=` + v5CallKind + `
		AND ` + v5ResolvedEdge + `
		AND target IN (SELECT id FROM nodes WHERE public_id IN (` + targets + `))
	)
	SELECT ` + v5SymbolColumns + `, coalesce(nullif(u.line,-1),n.start_line),
		coalesce((SELECT name FROM nodes WHERE id=u.target),'')` + v5SiteNodes + ` ORDER BY n.path, u.line LIMIT 500`
}

func (s *Store) v5Unresolved(id string) int {
	var key int64
	var name string
	if s.db.QueryRow("SELECT n.id, n.name FROM nodes n WHERE "+v5PublicIDWhere, v5IDArgs(id)...).Scan(&key, &name) != nil {
		return 0
	}
	// Use the interned called name. The written spelling can be different
	// (for example obj["method"]). A matching single candidate is already
	// reported by Callers.
	var count int
	_ = s.db.QueryRow(`SELECT count(*) FROM unresolved_calls
		WHERE name=(SELECT id FROM unresolved_names WHERE name=?2)
		AND (candidate IS NOT ?1 OR kind IS NOT `+v5CallKind+`)`, key, name).Scan(&count)
	return count
}

func (s *Store) v5UnresolvedIn(id string) int {
	var count int
	_ = s.db.QueryRow(s.v5Within()+`SELECT (
		SELECT count(*) FROM unresolved_calls WHERE source IN (SELECT id FROM inner)
		AND (candidate IS NULL OR kind IS NOT `+v5CallKind+`)
	) + (SELECT count(*) FROM unresolved_other WHERE source IN (SELECT id FROM inner))`, v5IDArgs(id)...).Scan(&count)
	return count
}

const v5CallsBetween = `WITH matched(id, path) AS MATERIALIZED (
		SELECT id, path FROM temp.v5_file_nodes WHERE path >= ?1 AND path < ?1 || char(1114111)
	), uses(source, target, line) AS MATERIALIZED (
		SELECT source, target, line FROM edges WHERE source IN (SELECT id FROM matched) AND kind=` + v5CallKind + ` AND ` + v5ResolvedEdge + `
		UNION ALL
		SELECT source, candidate, line FROM unresolved_calls WHERE source IN (SELECT id FROM matched)
		AND kind=` + v5CallKind + ` AND candidate IS NOT NULL
	)
	SELECT src.path, dst.path, coalesce(nullif(u.line,-1),0) FROM temp.v5_file_nodes dst
	CROSS JOIN uses u ON u.target=dst.id JOIN matched src ON src.id=u.source
	WHERE dst.id IN (SELECT target FROM uses) AND dst.path >= ?2 AND dst.path < ?2 || char(1114111)
	AND src.path <> dst.path ORDER BY 1, 3`
