// Package judgement reads bounded, checkout-bound model attestations. Only the
// evaluator can turn one into a cached verdict; a model answer alone is no proof.
package judgement

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

type proof struct {
	Version        int               `json:"version"`
	ID             string            `json:"id"`
	Checkout       string            `json:"checkout"`
	Position       gitstate.Position `json:"position"`
	EntryHash      string            `json:"entry_hash"`
	EvaluationHash string            `json:"evaluation_hash"`
	InputsHash     string            `json:"inputs_hash"`
	ChecksHash     string            `json:"checks_hash"`
	Result         string            `json:"result"`
	Label          string            `json:"label"`
	Model          string            `json:"model"`
	At             string            `json:"at"`
	Files          []struct {
		Path string  `json:"path"`
		Hash *string `json:"hash"`
	} `json:"files"`
}

type Reader struct {
	db                *record.Reader
	root              *os.Root
	project, checkout string
	files             map[string]string
	bytes             int
}

func Open(directory, project, checkout string) *Reader {
	if directory == "" || project == "" || !safefile.Regular(filepath.Join(directory, "record.db")) {
		return nil
	}
	db, err := record.OpenRecord(record.Location{Record: filepath.Join(directory, "record.db"), Directory: directory})
	if err != nil {
		return nil
	}
	root, err := os.OpenRoot(checkout)
	if err != nil {
		db.Close()
		return nil
	}
	return &Reader{db: db, root: root, project: project, checkout: checkout, files: map[string]string{}}
}
func (r *Reader) Close() {
	if r != nil {
		r.root.Close()
		r.db.Close()
	}
}
func digest(data []byte) string {
	v := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(v[:])
}
func validHash(s string) bool {
	if len(s) != 71 || !strings.HasPrefix(s, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(s[7:])
	return err == nil
}
func cacheHash(base, raw string) string {
	return "model:" + digest([]byte(base+"\njudge "+digest([]byte(raw))))
}

func inputsHash(p proof) string {
	parts := []string{"model-judgement-v1", p.Checkout, p.ID, p.EntryHash, p.EvaluationHash, p.ChecksHash, p.Model, p.Position.Branch, p.Position.Head}
	files := append(p.Files[:0:0], p.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	for _, f := range files {
		hash := "missing"
		if f.Hash != nil {
			hash = *f.Hash
		}
		parts = append(parts, f.Path, hash)
	}
	var b strings.Builder
	for _, s := range parts {
		b.WriteString(strconv.Itoa(len(s)))
		b.WriteByte(':')
		b.WriteString(s)
	}
	return digest([]byte(b.String()))
}

// ModelKey distinguishes derived model holds from free-check cache rows. The
// opaque key stays below the existing 80-byte observation bound.
func ModelKey(key string) bool {
	return strings.HasPrefix(key, "model:") && validHash(strings.TrimPrefix(key, "model:"))
}
func safe(path string) bool {
	if path == "" || len(path) > 512 || filepath.IsAbs(path) || strings.ContainsAny(path, "\\\x00\r\n\t*?[]{}") || (len(path) > 1 && path[1] == ':') {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func (r *Reader) fileHash(path string) string {
	if hash, ok := r.files[path]; ok {
		return hash
	}
	if !safe(path) || len(r.files) >= 256 || r.bytes >= 8<<20 {
		return ""
	}
	r.files[path] = ""
	f, err := r.root.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > 64<<10 {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(f, 64<<10+1))
	r.bytes += len(data)
	if err != nil || len(data) > 64<<10 || r.bytes > 8<<20 {
		return ""
	}
	r.files[path] = digest(data)
	return r.files[path]
}
func (r *Reader) read(id, entryHash string) (proof, string, bool) {
	if r == nil {
		return proof{}, "", false
	}
	raw, ok, err := r.db.BoundedSetting(r.project, "judge."+place.ShortHash(r.checkout)+"."+id, 128<<10)
	if err != nil || !ok {
		return proof{}, "", false
	}
	var p proof
	if json.Unmarshal([]byte(raw), &p) != nil || p.Version != 1 || p.ID != id || p.Checkout != r.checkout || p.EntryHash != entryHash || p.Result != "still-true" || p.Label != "checked by model" || p.Model == "" || len(p.Model) > 128 || len(p.Files) == 0 || len(p.Files) > 16 || !validHash(p.EvaluationHash) || !validHash(p.InputsHash) || !validHash(p.ChecksHash) {
		return proof{}, "", false
	}
	if _, err := time.Parse(time.RFC3339Nano, p.At); err != nil {
		return proof{}, "", false
	}
	if inputsHash(p) != p.InputsHash {
		return proof{}, "", false
	}
	at, ok := gitstate.Read(r.checkout)
	if !ok || at != p.Position {
		return proof{}, "", false
	}
	retired, err := r.db.HasSetting(r.project, "knowledge.retired."+id)
	if err != nil || retired {
		return proof{}, "", false
	}
	result, ok, err := r.db.Judgement(r.project, id, p.InputsHash)
	if err != nil || !ok || result != p.Result {
		return proof{}, "", false
	}
	seen := map[string]bool{}
	for _, f := range p.Files {
		if seen[f.Path] || f.Hash == nil || !validHash(*f.Hash) || r.fileHash(f.Path) != *f.Hash {
			return proof{}, "", false
		}
		seen[f.Path] = true
	}
	if now, ok := gitstate.Read(r.checkout); !ok || now != at {
		return proof{}, "", false
	}
	return p, raw, true
}

// CacheKey binds cache reuse to the native evaluation, the complete attestation,
// checkout position and all evidence files. Removal or expiry restores stage one.
func (r *Reader) CacheKey(id, entryHash, evaluationHash string) (string, bool) {
	p, raw, ok := r.read(id, entryHash)
	if !ok || p.EvaluationHash != evaluationHash {
		return evaluationHash, false
	}
	return cacheHash(evaluationHash, raw), true
}

// Label describes a held verdict only when this precise attestation produced it.
func (r *Reader) Label(id, entryHash, cachedHash string) bool {
	p, raw, ok := r.read(id, entryHash)
	return ok && cacheHash(p.EvaluationHash, raw) == cachedHash
}
