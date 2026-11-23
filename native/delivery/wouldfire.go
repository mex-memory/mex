package delivery

import (
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

// WouldFireEdit is one file change of one past commit: the lines it added and
// the lines it removed, as the speed bump would have seen them.
type WouldFireEdit struct {
	Commit  string `json:"commit"`
	Path    string `json:"path"`
	Added   string `json:"added"`
	Removed string `json:"removed"`
}

// WouldFireMatch is a rule that would have stopped a change or been shown on a touch.
type WouldFireMatch struct {
	Entry   string `json:"entry"`
	Commit  string `json:"commit"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Pattern string `json:"pattern,omitempty"`
}

const (
	wouldFireEdits   = 400
	wouldFireBytes   = 32768
	wouldFireMatches = 3
)

// WouldFire replays edits through the delivery matchers, without denying edits or
// recording session state. Each rule gets one example, with edit stops first.
func WouldFire(items []*entries.Item, edits []WouldFireEdit) []WouldFireMatch {
	snap, anchors := &entries.Snapshot{}, &entries.Snapshot{}
	for _, it := range items {
		if it == nil || it.Entry == nil || it.Entry.Status == "retired" {
			continue
		}
		item := *it
		if item.Entry.Status == "proposed" {
			// The review asks whether to tick this rule.
			e := *item.Entry
			e.Status = "active"
			item.Entry = &e
		}
		snap.Items = append(snap.Items, item)
		if item.Entry.Learned() && len(item.Entry.When) == 0 && learnedProse(item.Entry) {
			anchors.Items = append(anchors.Items, item)
		}
	}
	if len(snap.Items) == 0 {
		return nil
	}
	if len(edits) > wouldFireEdits {
		edits = edits[:wouldFireEdits]
	}
	var out []WouldFireMatch
	seen := map[string]bool{}
	add := func(it *entries.Item, edit WouldFireEdit, typ, pattern string) bool {
		id := it.Entry.ID
		if !seen[id] {
			seen[id] = true
			out = append(out, WouldFireMatch{Entry: id, Commit: edit.Commit, Path: edit.Path, Type: typ, Pattern: pattern})
		}
		return len(out) == wouldFireMatches
	}
	for _, edit := range edits {
		if edit.Path == "" || edit.Added == "" {
			continue
		}
		for _, b := range matchEdit(snap, edit.Path, boundedText(edit.Added, wouldFireBytes), boundedText(edit.Removed, wouldFireBytes)) {
			if add(b.item, edit, b.trigger.Type, b.trigger.Pattern) {
				return out
			}
		}
	}
	if len(anchors.Items) == 0 {
		return out
	}
	for _, edit := range edits {
		for _, c := range moments(toolView{name: contract.ToolEdit, rel: edit.Path}, anchors, nil, nil) {
			if c.moment == momentAnchor && add(c.item, edit, momentAnchor, "") {
				return out
			}
		}
	}
	return out
}
