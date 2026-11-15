package brief

import (
	"encoding/json"
	"os"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record/place"
)

// imported validates the cached projection through the full delivery codec.
func imported(cache ruleCache) []entries.Item {
	blocked, hashes := map[string]bool{}, map[string]string{}
	for _, review := range cache.Review {
		for _, file := range review.Paths {
			blocked[file] = true
		}
	}
	for _, file := range cache.Files {
		hashes[file.Path] = file.Hash
	}
	var out []entries.Item
	for _, rule := range cache.Entries {
		if blocked[rule.Path] || rule.Entry.Mex.Source.Type != "rule-file" || rule.Entry.Mex.Source.Ref != rule.Path {
			continue
		}
		data, err := json.Marshal(rule.Entry.Mex)
		if err != nil {
			continue
		}
		var meta map[string]any
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		delete(meta, "text")
		header, _ := json.Marshal(map[string]any{"mex": meta})
		e, err := entries.Parse([]byte("---\n" + string(header) + "\n---\n" + rule.Entry.Text + "\n"))
		if err != nil {
			continue
		}
		out = append(out, entries.Item{Entry: e, Level: "rule-file", Path: rule.Path, Hash: hashes[rule.Path], OneLine: "[repo] " + e.OneLine, Full: "[repo] " + e.Text})
	}
	return out
}

// ReadImported lets resume and recovery resolve entries first given by the brief.
func ReadImported(opts Options) []entries.Item {
	canonical, err := place.RealPath(opts.Checkout)
	if err != nil {
		return nil
	}
	opts.Checkout = canonical
	root, err := os.OpenRoot(canonical)
	if err != nil {
		return nil
	}
	defer root.Close()
	home, err := os.OpenRoot(opts.MexHome)
	if err != nil {
		return nil
	}
	defer home.Close()
	return imported(readRules(root, home, opts))
}
