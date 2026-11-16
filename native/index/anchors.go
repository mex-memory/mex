package index

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

// HasPath verifies a path in the existing snapshot, including listed non-code
// files. The caller separately checks current existence and containment.
func (r *Reader) HasPath(path string) bool {
	var exists bool
	return r.db.QueryRow("SELECT EXISTS(SELECT 1 FROM paths WHERE path=?)", path).Scan(&exists) == nil && exists
}

// FindLiteral bounds arbitrary quoted-error verification to 32 indexed files
// and 256 KiB total. It does not persist the searched text or scan ignored files.
func (r *Reader) FindLiteral(literal string) (string, int) {
	if len(literal) < 4 || len(literal) > 200 {
		return "", 0
	}
	rows, err := r.db.Query("SELECT path FROM paths WHERE reason IS NULL AND size<=65536 ORDER BY path LIMIT 32")
	if err != nil {
		return "", 0
	}
	defer rows.Close()
	root, err := os.OpenRoot(r.root)
	if err != nil {
		return "", 0
	}
	defer root.Close()
	remaining := int64(256 << 10)
	for rows.Next() {
		var p string
		if rows.Scan(&p) != nil {
			return "", 0
		}
		f, err := root.Open(filepath.FromSlash(p))
		if err != nil {
			continue
		}
		stat, err := f.Stat()
		if err != nil || !stat.Mode().IsRegular() || stat.Size() > remaining {
			f.Close()
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, remaining+1))
		f.Close()
		remaining -= int64(len(data))
		if err != nil || remaining < 0 {
			return "", 0
		}
		if at := strings.Index(string(data), literal); at >= 0 {
			return p, 1 + strings.Count(string(data[:at]), "\n")
		}
		if remaining == 0 {
			break
		}
	}
	return "", 0
}

// DefinitionCount includes stale files, so a stale collision cannot turn into
// a misleading unique pointer. SQL stops once uniqueness is disproved.
func (r *Reader) DefinitionCount(name string) int {
	var count int
	err := r.db.QueryRow(`SELECT count(*) FROM (SELECT DISTINCT p.path,s.start,s.end FROM
 (SELECT hash,lang,start,end FROM main.symbols WHERE name=?1 UNION ALL SELECT hash,lang,start,end FROM base.symbols WHERE name=?1) s
 JOIN paths p ON p.hash=s.hash AND p.lang=s.lang LIMIT 5)`, name).Scan(&count)
	if err != nil {
		return 0
	}
	return count
}
