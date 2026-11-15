package hook

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Only the originating main session can see a fix preview. A receipt is made
// only after the adapter's person-visible reply is completely written.
func judgeNotice(ev contract.Event, h home, directory string) (string, string) {
	if ev.SessionID == "" || ev.AgentID != "" || ev.ProjectID == "" || ev.Checkout == "" {
		return "", ""
	}
	key := place.ShortHash(ev.Checkout + "\x00" + ev.Agent + "\x00" + ev.SessionID)
	data, err := boundedJudgeRead(filepath.Join(directory, "judge-notices", key+".json"), 4096)
	if err != nil {
		return "", ""
	}
	var ids []string
	if json.Unmarshal(data, &ids) != nil || len(ids) > 16 || len(ids) == 0 {
		return "", ""
	}
	for _, id := range ids {
		if !judgeNoticeID.MatchString(id) {
			return "", ""
		}
	}
	location := hooksLocation(h, directory)
	reader, err := localrecord.OpenRecord(location)
	if err != nil {
		return "", ""
	}
	defer reader.Close()
	hooks, err := localrecord.OpenHooks(location)
	if err != nil {
		return "", ""
	}
	defer hooks.Close()
	for _, id := range ids {
		if shown, err := hooks.NoticeShown(id); err != nil {
			return "", ""
		} else if shown {
			continue
		}
		kind := "judge"
		if strings.HasPrefix(id, "learning.team.") {
			kind = "learning"
		}
		notice, err := reader.JudgeNotice(id, kind+"-preview."+key, kind+"-updated."+key)
		if err != nil {
			return "", ""
		}
		if notice == nil {
			continue
		}
		at, ok := judgeGitPosition(ev.Checkout)
		if !ok {
			return "", ""
		}
		var message struct {
			Version  int           `json:"version"`
			Position judgePosition `json:"position"`
			Text     string        `json:"text"`
		}
		if json.Unmarshal([]byte(notice.Text), &message) != nil || message.Version != 1 || message.Position != at || message.Text == "" || strings.IndexByte(message.Text, 0) >= 0 {
			continue
		}
		return notice.ID, message.Text
	}
	return "", ""
}

var judgeNoticeID = regexp.MustCompile(`^(judge\.fix|learning\.team)\.[a-f0-9]{24}\.(preview|updated)$`)

func markJudgeNotice(ev contract.Event, h home, directory, id string, now time.Time) bool {
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return false
	}
	defer hooks.Close()
	return hooks.MarkNotice(id, localrecord.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}, now) == nil
}
