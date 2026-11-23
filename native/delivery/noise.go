package delivery

import (
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
)

type noiseReader struct {
	directory string
	tried     bool
	db        *record.Reader
	cache     map[[2]string]bool
}

func (n *noiseReader) close() {
	if n.db != nil {
		_ = n.db.Close()
	}
}

// Called only for a matching stop or an in-scope prose delivery candidate.
func (n *noiseReader) suppressed(project, id string) bool {
	if !n.tried {
		n.tried = true
		path := filepath.Join(n.directory, "record.db")
		if n.directory != "" && safefile.Regular(path) {
			n.db, _ = record.OpenRecord(record.Location{Directory: n.directory, Record: path})
		}
		n.cache = make(map[[2]string]bool)
	}
	if n.db == nil {
		return false
	}
	key := [2]string{project, id}
	if value, found := n.cache[key]; found {
		return value
	}
	raw, ok, err := n.db.BoundedSetting(project, "learning.noise."+id, 512)
	var row struct {
		Stops, Ignored int
		At             string
	}
	valid := err == nil && ok && json.Unmarshal([]byte(raw), &row) == nil && row.Stops >= 20 && row.Stops <= 100000 && row.Ignored <= row.Stops && row.Ignored*10 > row.Stops
	if _, err := time.Parse(time.RFC3339Nano, row.At); err != nil {
		valid = false
	}
	n.cache[key] = valid
	return valid
}
