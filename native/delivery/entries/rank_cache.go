package entries

import (
	"strings"

	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/internal/binenc"
)

type rankCache struct {
	Stamp  string
	Hashes map[string]string
	Index  *rank.Index
}

// PromptIndex is a prompt-only read. Tool misses never read or build this
// cache. It shares the already validated listing stamp with the light index.
// A miss builds once from current source entries; a hit reads statistics only.
func PromptIndex(directory, home, project, checkout string, snap Snapshot) (*rank.Index, Snapshot, error) {
	path := strings.TrimSuffix(CachePath(directory, project, checkout), ".json") + ".rank.bin"
	var c rankCache
	if snap.Stamp != "" {
		if b, err := readRegular(path, 32<<20); err == nil && decodeRankCache(b, &c) == nil && c.Stamp == snap.Stamp && c.Index != nil && len(c.Hashes) == len(snap.Items) {
			valid := true
			for _, it := range snap.Items {
				if c.Hashes[it.Entry.ID] != it.Hash {
					valid = false
					break
				}
			}
			if valid {
				return c.Index, snap, nil
			}
		}
	}
	full := snap
	if snap.Light {
		var err error
		full, err = Load(directory, home, project, checkout)
		if err != nil {
			return nil, Snapshot{}, err
		}
	}
	docs := make([]rank.Doc, 0, len(full.Items))
	for _, it := range full.Items {
		docs = append(docs, RankDoc(it.Entry))
	}
	ix := rank.Build(docs)
	stamp, _, err := listingStamp(home, project, checkout)
	if err != nil {
		return nil, Snapshot{}, err
	}
	// If metadata changed while loading, do not publish a cache for that listing.
	if snap.Stamp != "" && stamp == snap.Stamp {
		b, err := encodeRankCache(stamp, full.Items, ix)
		if err == nil && len(b) <= 32<<20 {
			saveFile(path, b)
		}
	}
	full.Stamp = stamp
	return ix, full, nil
}

func encodeRankCache(stamp string, items []Item, ix *rank.Index) ([]byte, error) {
	var w binenc.Writer
	w.String(stamp)
	w.Uint(uint64(len(items)))
	for _, it := range items {
		w.String(it.Entry.ID)
		w.String(it.Hash)
	}
	b, err := ix.MarshalBinary()
	if err != nil {
		return nil, err
	}
	w.String(string(b))
	return w.Bytes(), nil
}

func decodeRankCache(b []byte, c *rankCache) error {
	r := binenc.NewReader(b)
	c.Stamp = r.String()
	c.Hashes = map[string]string{}
	n := r.Count(10000)
	for i := 0; i < n && r.Err() == nil; i++ {
		id := r.String()
		c.Hashes[id] = r.String()
	}
	index := r.String()
	if err := r.Done(); err != nil {
		return err
	}
	c.Index = &rank.Index{}
	return c.Index.UnmarshalBinary([]byte(index))
}
