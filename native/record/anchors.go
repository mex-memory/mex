package record

import (
	"github.com/mex-memory/mex/native/record/place"
	"os"
	"path/filepath"
)

func anchorHint(session, agent, checkout, path string) string {
	return filepath.Join("anchor-armed", place.ShortHash(session+"\x00"+agent), place.ShortHash(checkout+"\x00"+path))
}

// AnchorPending is only a fast-path hint. Held receipt targets still authorize
// release in the current epoch, under the normal presence and truth gates.
func AnchorPending(directory, session, agent, checkout, path string) bool {
	info, err := os.Lstat(filepath.Join(directory, anchorHint(session, agent, checkout, path)))
	return err == nil && info.Mode().IsRegular()
}

func (h *Hooks) noteAnchorHints(req DeliveryRequest, receipts []Receipt) {
	eligible := false
	for _, r := range receipts {
		eligible = eligible || r.Moment == "prompt-arm" && r.Action == "held-back"
	}
	if !eligible {
		return
	}
	root, err := os.OpenRoot(h.directory)
	if err != nil {
		return
	}
	defer root.Close()
	parent := filepath.Join("anchor-armed", place.ShortHash(req.Session.SessionID+"\x00"+req.AgentID))
	for _, dir := range []string{"anchor-armed", parent} {
		if err = root.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return
		}
		info, err := root.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return
		}
	}
	for _, r := range receipts {
		if r.Moment != "prompt-arm" || r.Action != "held-back" {
			continue
		}
		for _, path := range r.Target.Paths {
			f, err := root.OpenFile(anchorHint(req.Session.SessionID, req.AgentID, req.Session.Checkout, path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err == nil {
				f.Close()
			}
		}
	}
}
