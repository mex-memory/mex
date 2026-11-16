package record

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/record/place"
)

type AdviceReceipt struct {
	ID      string         `json:"id"`
	Session string         `json:"session"`
	Agent   string         `json:"agent"`
	Epoch   int            `json:"epoch"`
	Effects []AdviceEffect `json:"effects"`
	Partial bool           `json:"partial"`
}
type AdviceAdvisory struct {
	Version  int             `json:"version"`
	ID       string          `json:"id"`
	Checkout string          `json:"checkout"`
	Branch   string          `json:"branch"`
	Entry    string          `json:"entry"`
	Text     string          `json:"text"`
	Label    string          `json:"label"`
	Receipts []AdviceReceipt `json:"receipts"`
	Partial  bool            `json:"partial"`
	Origin   struct {
		Kind           string `json:"kind"`
		HeldInputsHash string `json:"held_inputs_hash"`
	} `json:"origin"`
}

var adviceID = regexp.MustCompile(`^advice\.[a-f0-9]{24}$`)

// A missing hint costs only filesystem metadata, never a database open. The
// hint contains IDs only; the Node-owned database remains authoritative.
func AdviceIDs(directory, checkout string) []string {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil
	}
	defer root.Close()
	info, err := root.Lstat("judge-advice")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	at, ok := gitstate.Read(checkout)
	if !ok {
		return nil
	}
	path := filepath.Join("judge-advice", place.ShortHash(checkout+"\x00"+at.Branch)+".json")
	expected, err := root.Lstat(path)
	if err != nil || !expected.Mode().IsRegular() || expected.Size() > 2048 {
		return nil
	}
	f, err := root.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	actual, err := f.Stat()
	if err != nil || !os.SameFile(expected, actual) {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(f, 2049))
	if err != nil || len(data) > 2048 {
		return nil
	}
	var ids []string
	if json.Unmarshal(data, &ids) != nil || len(ids) > 32 {
		return nil
	}
	for _, id := range ids {
		if !adviceID.MatchString(id) {
			return nil
		}
	}
	return ids
}
func (r *Reader) Advice(project, checkout, branch string, ids []string) []AdviceAdvisory {
	var out []AdviceAdvisory
	for _, id := range ids {
		if !adviceID.MatchString(id) {
			continue
		}
		data, ok, err := r.BoundedSetting(project, id, 64<<10)
		if err != nil || !ok {
			continue
		}
		var a AdviceAdvisory
		if json.Unmarshal([]byte(data), &a) != nil || a.Version != 1 || a.ID != id || a.Checkout != checkout || a.Branch != branch || len(a.Receipts) > 128 ||
			a.Text == "" || len(a.Text) > 2048 || strings.ContainsAny(a.Text, "\x00\r\n") || !regexp.MustCompile(`^mx_[a-z0-9]{6,64}$`).MatchString(a.Entry) {
			continue
		}
		out = append(out, a)
	}
	return out
}
