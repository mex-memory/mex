package capture

import (
	"encoding/json"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

type learnedItem struct {
	ID      string `json:"id"`
	Session string `json:"session"`
	At      string `json:"at"`
	Head    string `json:"head"`
	Text    string `json:"text"`
}
type learnedContinuity struct {
	Version  int           `json:"version"`
	Checkout string        `json:"checkout"`
	Branch   string        `json:"branch"`
	Items    []learnedItem `json:"items"`
}

var learnedID = regexp.MustCompile(`^[a-f0-9]{24}$`)
var learnedHead = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

// LearnedContinuityCarries reads Node-owned derived data, never repairs or
// writes record.db. Per-item notice IDs survive later batches and hook snapshots.
func LearnedContinuityCarries(ev contract.Event, env Env) []Carry {
	if ev.AgentID != "" || ev.SessionID == "" || ev.ProjectID == "" || ev.Checkout == "" {
		return nil
	}
	branch := Branch(ev.Checkout)
	if branch == "" {
		return nil
	}
	for _, name := range []string{"record.db", "record.db-wal", "record.db-shm"} {
		if !safefile.Regular(filepath.Join(env.RecordDirectory, name)) {
			return nil
		}
	}
	r, err := record.OpenRecord(record.Location{Directory: env.RecordDirectory, Record: filepath.Join(env.RecordDirectory, "record.db")})
	if err != nil {
		return nil
	}
	defer r.Close()
	project, found, err := r.CheckoutProjectID(ev.Checkout)
	if err != nil || !found || project != ev.ProjectID {
		return nil
	}
	raw, found, err := r.BoundedSetting(project, "learning.continuity."+place.ShortHash(ev.Checkout+"\x00"+branch), 16<<10)
	if err != nil || !found {
		return nil
	}
	var saved learnedContinuity
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&saved) != nil || saved.Version != 1 || saved.Checkout != ev.Checkout || saved.Branch != branch || len(saved.Items) == 0 || len(saved.Items) > 3 {
		return nil
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil
	}
	head := Head(ev.Checkout, branch)
	if head == "" || Merged(ev.Checkout, branch, head) {
		return nil
	}
	checkedDirty, dirty := false, false
	var carries []Carry
	seen := map[string]bool{}
	for _, item := range saved.Items {
		at, err := time.Parse(time.RFC3339Nano, item.At)
		if err != nil || at.After(now(env)) || now(env).Sub(at) >= ContinuityTTL || !learnedID.MatchString(item.ID) || !learnedHead.MatchString(item.Head) || len(item.Session) == 0 || len(item.Session) > 512 || item.Session == ev.SessionID {
			continue
		}
		if item.Text == "" || utf8.RuneCountInString(item.Text) > 120 || strings.IndexFunc(item.Text, unicode.IsControl) >= 0 || Redact(item.Text) != item.Text || seen[item.ID] {
			continue
		}
		if item.Head != head {
			if !checkedDirty {
				_, count, ok := Uncommitted(ev.Checkout, 0)
				dirty = ok && count > 0
				checkedDirty = true
			}
			if !dirty {
				continue
			}
		}
		seen[item.ID] = true
		text := "Next session on " + branch + " (personal, from the person's earlier session; not verified): " + item.Text
		carries = append(carries, Carry{EntryID: "mex:continuity:" + item.ID, NoticeID: "continuity-filter:" + place.ShortHash(ev.Checkout+"\x00"+branch+"\x00"+item.ID), Text: text, Tokens: Tokens(text)})
	}
	return carries
}
