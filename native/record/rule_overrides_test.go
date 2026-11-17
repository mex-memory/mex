package record

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRuleOverridesRequireMainAgentBumpAndDeduplicate(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	_, err = h.db.Exec(`INSERT INTO sessions VALUES('s','codex','p','/repo','now','now',0);
 INSERT INTO epochs(session_id,agent_id,epoch,started_at) VALUES('s','',0,'now'),('s','child',0,'now');
 INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action) VALUES
 ('bump','s','',0,'now','speed-bump','mx_policy0','full',1,'given'),
 ('read','s','',0,'now','read','mx_policy0','full',1,'given'),
 ('child','s','child',0,'now','speed-bump','mx_policy0','full',1,'given'),
 ('held','s','',0,'now','speed-bump','mx_policy0','full',1,'held-back');`)
	if err != nil {
		t.Fatal(err)
	}
	hash := "sha256:" + strings.Repeat("a", 64)
	person := strings.Repeat("b", 64)
	for _, id := range []string{"bump", "bump", "read", "child", "held", "missing"} {
		if err = h.RecordRuleOverride(id, hash, person, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	var raw string
	if err = h.db.QueryRow("SELECT count(*),detail FROM followups").Scan(&n, &raw); err != nil || n != 1 {
		t.Fatal(n, raw, err)
	}
	var value map[string]any
	if json.Unmarshal([]byte(raw), &value) != nil || value["entry_hash"] != hash || value["person"] != person || value["type"] != "speed-bump-override" {
		t.Fatal(raw)
	}
	if h.RecordRuleOverride("bump", "not a hash", "", time.Now()) == nil {
		t.Fatal("invalid hash accepted")
	}
}
