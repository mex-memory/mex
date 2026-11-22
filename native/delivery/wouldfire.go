package delivery

import "github.com/mex-memory/mex/native/delivery/entries"

// WouldFireEdit is one file change of one past commit: the lines it added and
// the lines it removed, as the speed bump would have seen them.
type WouldFireEdit struct {
	Commit  string `json:"commit"`
	Path    string `json:"path"`
	Added   string `json:"added"`
	Removed string `json:"removed"`
}

// WouldFireMatch is a rule that would have stopped one past change.
type WouldFireMatch struct {
	Entry   string `json:"entry"`
	Commit  string `json:"commit"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Pattern string `json:"pattern"`
}

const (
	wouldFireEdits   = 400
	wouldFireBytes   = 32768
	wouldFireMatches = 64
)

// WouldFire replays past edits through the speed bump's own matching (matchEdit),
// with no session state and no deny. It answers "which of these rules would
// have stopped which of these changes": one match per rule and commit.
func WouldFire(items []*entries.Item, edits []WouldFireEdit) []WouldFireMatch {
	snap := &entries.Snapshot{}
	for _, it := range items {
		if it == nil || it.Entry == nil || it.Entry.Status == "retired" {
			continue
		}
		item := *it
		if item.Entry.Status == "proposed" {
			// The review list asks whether to tick a waiting rule: replay it as if ticked.
			e := *item.Entry
			e.Status = "active"
			item.Entry = &e
		}
		snap.Items = append(snap.Items, item)
	}
	if len(snap.Items) == 0 {
		return nil
	}
	var out []WouldFireMatch
	seen := map[string]bool{}
	for i, edit := range edits {
		if i >= wouldFireEdits || len(out) >= wouldFireMatches {
			break
		}
		if edit.Path == "" || edit.Added == "" {
			continue
		}
		for _, b := range matchEdit(snap, edit.Path, boundedText(edit.Added, wouldFireBytes), boundedText(edit.Removed, wouldFireBytes)) {
			key := b.item.Entry.ID + "\x00" + edit.Commit
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, WouldFireMatch{Entry: b.item.Entry.ID, Commit: edit.Commit, Path: edit.Path, Type: b.trigger.Type, Pattern: b.trigger.Pattern})
		}
	}
	return out
}
