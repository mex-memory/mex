package entries

import (
	"os"
	"path/filepath"

	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
)

// Retirements checks the local retirement state of matched entries. Keep one
// reader per event so repeated matches share a lookup without caching across
// hooks: forget need not change the entry file or any snapshot stamp.
type Retirements struct {
	Directory string
	tried     bool
	absent    bool
	reader    *record.Reader
	allowed   map[[2]string]bool
}

func (r *Retirements) Allows(project string, item *Item) bool {
	if item.Level != "personal" && item.Level != "hint" {
		return true
	}
	if !r.tried {
		r.tried = true
		path := filepath.Join(r.Directory, "record.db")
		if _, err := os.Stat(path); r.Directory == "" || os.IsNotExist(err) {
			r.absent = true // nothing was ever recorded here, so nothing was dropped
		} else if safefile.Regular(path) {
			r.reader, _ = record.OpenRecord(record.Location{Record: path})
		}
	}
	if r.absent {
		return true
	}
	if r.reader == nil {
		return false // a record that can't be read may hold the drop
	}
	key := [2]string{project, item.Entry.ID}
	if ok, checked := r.allowed[key]; checked {
		return ok
	}
	// Presence alone is authoritative, even if the retirement value is invalid.
	retired, err := r.reader.HasSetting(project, "knowledge.retired."+item.Entry.ID)
	ok := err == nil && !retired
	if r.allowed == nil {
		r.allowed = make(map[[2]string]bool)
	}
	r.allowed[key] = ok
	return ok
}

func (r *Retirements) Close() {
	if r.reader != nil {
		_ = r.reader.Close()
	}
}
