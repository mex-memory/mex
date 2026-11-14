package delivery

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/mex-memory/mex/native/internal/binenc"
	"github.com/mex-memory/mex/native/record/place"
)

// Rewind on Claude Code: the transcript is JSONL where each message names
// its parent (uuid, parentUuid). A rewind starts a new branch from an older
// message and leaves the abandoned messages in the file. Before skipping an
// entry as "already sent", the controller asks whether the block that carried
// it is still on the active branch: the chain of parents from the newest
// message.
//
// The answer is cached per transcript and updated from the bytes appended
// since the last look. While new messages continue the same chain, only the
// appended bytes are read. A new branch reloads the stored parent links and
// walks them again. Every bound or doubt answers "still present", so a
// transcript MEX can't read never causes a resend.

const (
	maxTranscriptBytes = 64 << 20 // never index more than this
	maxTailBytes       = 16 << 20 // never read more than this per call
	maxNodes           = 200000
)

type tnode struct {
	Parent string
	Blocks []string
}

type tcache struct {
	Version int
	Path    string
	Offset  int64
	ModTime int64
	Tip     string
	Active  map[string]bool // blocks on the active branch
	Seen    map[string]bool // blocks anywhere in the transcript
	Nodes   map[string]tnode
}

const tcacheVersion = 1

func transcriptCachePath(recordDirectory, transcript string) string {
	return filepath.Join(recordDirectory, "delivery-transcripts", place.ShortHash(transcript)+".bin")
}

var blockRE = lazy(`\[mex ([0-9a-f]{24})\]`)

type tline struct {
	UUID        string `json:"uuid"`
	ParentUUID  string `json:"parentUuid"`
	IsSidechain bool   `json:"isSidechain"`
}

// blockState says whether a block is on the active branch. known is false when
// the transcript can't answer (missing, too large, never mentions the block):
// callers then keep treating the entry as present.
type blockState func(block string) (active, known bool)

func transcriptBlocks(recordDirectory, transcript string) blockState {
	doubt := func(string) (bool, bool) { return true, false }
	if transcript == "" || recordDirectory == "" {
		return doubt
	}
	info, err := os.Stat(transcript)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxTranscriptBytes {
		return doubt
	}
	cachePath := transcriptCachePath(recordDirectory, transcript)
	c := tcache{}
	if b, err := readBounded(cachePath, 32<<20); err == nil {
		if d, err := decodeTranscript(b); err == nil && d.Version == tcacheVersion && d.Path == transcript && d.Offset <= info.Size() {
			c = d
		}
	}
	if c.Version == 0 {
		c = tcache{Version: tcacheVersion, Path: transcript, Active: map[string]bool{}, Seen: map[string]bool{}, Nodes: map[string]tnode{}}
	}
	if c.Offset < info.Size() || c.ModTime != info.ModTime().UnixNano() {
		if info.Size()-c.Offset > maxTailBytes && c.Offset != 0 {
			return doubt
		}
		if err := c.update(transcript, info); err != nil {
			return doubt
		}
		saveTranscriptCache(cachePath, c)
	}
	return func(block string) (bool, bool) {
		if !c.Seen[block] {
			return true, false
		}
		return c.Active[block], true
	}
}

func (c *tcache) update(transcript string, info os.FileInfo) error {
	f, err := os.Open(transcript)
	if err != nil {
		return err
	}
	defer f.Close()
	if c.ModTime != 0 && c.Offset == info.Size() {
		// Same size, new time: rewritten in place. Start over.
		*c = tcache{Version: tcacheVersion, Path: transcript, Active: map[string]bool{}, Seen: map[string]bool{}, Nodes: map[string]tnode{}}
	}
	if _, err := f.Seek(c.Offset, io.SeekStart); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxTranscriptBytes))
	if err != nil {
		return err
	}
	// Only whole lines: a line still being written is read next time.
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil
	}
	data = data[:end+1]
	branched := false
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		line := data[:i]
		data = data[i+1:]
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var l tline
		if json.Unmarshal(line, &l) != nil || l.UUID == "" || l.IsSidechain {
			continue
		}
		var blocks []string
		if bytes.Contains(line, []byte("[mex ")) {
			for _, m := range blockRE().FindAllSubmatch(line, 16) {
				blocks = append(blocks, string(m[1]))
				c.Seen[string(m[1])] = true
			}
		}
		if len(c.Nodes) >= maxNodes {
			return errors.New("transcript too long to index")
		}
		c.Nodes[l.UUID] = tnode{Parent: l.ParentUUID, Blocks: blocks}
		if !branched && (c.Tip == "" || l.ParentUUID == c.Tip) {
			for _, b := range blocks {
				c.Active[b] = true
			}
		} else {
			branched = true
		}
		c.Tip = l.UUID
	}
	c.Offset += int64(end + 1)
	c.ModTime = info.ModTime().UnixNano()
	if branched {
		c.Active = map[string]bool{}
		at, steps := c.Tip, 0
		for at != "" && steps < maxNodes {
			n, ok := c.Nodes[at]
			if !ok {
				break
			}
			for _, b := range n.Blocks {
				c.Active[b] = true
			}
			at = n.Parent
			steps++
		}
	}
	return nil
}

func encodeTranscript(c tcache) []byte {
	var w binenc.Writer
	w.Uint(uint64(c.Version))
	w.String(c.Path)
	w.Int(c.Offset)
	w.Int(c.ModTime)
	w.String(c.Tip)
	w.Set(c.Active)
	w.Set(c.Seen)
	w.Uint(uint64(len(c.Nodes)))
	for id, n := range c.Nodes {
		w.String(id)
		w.String(n.Parent)
		w.Strings(n.Blocks)
	}
	return w.Bytes()
}

func decodeTranscript(b []byte) (tcache, error) {
	r := binenc.NewReader(b)
	c := tcache{Version: int(r.Uint()), Path: r.String(), Offset: r.Int(), ModTime: r.Int(), Tip: r.String(), Active: r.Set(maxNodes), Seen: r.Set(maxNodes), Nodes: map[string]tnode{}}
	for i, n := 0, r.Count(maxNodes); i < n && r.Err() == nil; i++ {
		id := r.String()
		c.Nodes[id] = tnode{Parent: r.String(), Blocks: r.Strings(16)}
	}
	return c, r.Done()
}

func saveTranscriptCache(path string, c tcache) {
	buf := bytes.NewBuffer(encodeTranscript(c))
	dir := filepath.Dir(path)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	f, err := os.CreateTemp(dir, ".transcript-*")
	if err != nil {
		return
	}
	_, werr := f.Write(buf.Bytes())
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(f.Name(), path) != nil {
		_ = os.Remove(f.Name())
	}
}
