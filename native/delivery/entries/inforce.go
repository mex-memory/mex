package entries

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// InForcePath is the mirror Node publishes after each acceptance pass: the ids
// of proposed decisions whose cited commit landed on the default branch and
// wasn't reverted. The authority is the append-only log in record.db.
func InForcePath(home, project string) string {
	return filepath.Join(home, "projects", project, "decisions-in-force.json")
}

// InForce reads the mirror. A missing or invalid file means none are in force,
// so a proposed entry is never delivered on doubt.
func InForce(home, project string) map[string]bool {
	if home == "" || !validComponent(project) {
		return nil
	}
	b, err := readRegular(InForcePath(home, project), 256*1024)
	if err != nil {
		return nil
	}
	var v struct {
		Version int
		IDs     []string
	}
	if json.Unmarshal(b, &v) != nil || v.Version != 1 || len(v.IDs) > maxChildren {
		return nil
	}
	out := map[string]bool{}
	for _, id := range v.IDs {
		if idRE().MatchString(id) {
			out[id] = true
		}
	}
	return out
}

// Usable is the delivery rule for an entry's status: active, or proposed and
// now in force. Anything else is never delivered as accepted knowledge.
func Usable(e *Entry, inForce map[string]bool) *Entry {
	switch {
	case e == nil:
		return nil
	case e.Status == "active":
		return e
	case e.Status == "proposed" && inForce[e.ID]:
		c := *e
		c.Status = "active"
		return &c
	}
	return nil
}

// inForceStamp folds the mirror's size and time into a listing stamp, so a
// change of what is in force invalidates the cached snapshots.
func inForceStamp(home, project string) string {
	info, err := os.Lstat(InForcePath(home, project))
	if err != nil {
		return "none"
	}
	return info.ModTime().UTC().Format("20060102T150405.000000000") + "/" + itoa(info.Size())
}
func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }
