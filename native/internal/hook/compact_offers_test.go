package hook

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/record/place"
)

func TestCompactionOfferNoticeIsPersonOnlyAndOncePerHost(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			checkout := repo(t, t.TempDir())
			other := repo(t, t.TempDir())
			register(t, h, checkout, projectID, "on", "")
			register(t, h, other, projectID, "on", "")
			prepareStore(t, h)
			send := func(event, cwd, session string) map[string]json.RawMessage {
				t.Helper()
				raw, err := json.Marshal(map[string]string{
					"hook_event_name": event, "session_id": session, "cwd": cwd, "source": "startup",
					"prompt": "Review the registry migration and its tests.",
				})
				if err != nil {
					t.Fatal(err)
				}
				code, output := run(t, []string{agent, event}, bytes.NewReader(raw), env)
				var reply map[string]json.RawMessage
				if code != 0 || json.Unmarshal([]byte(output), &reply) != nil {
					t.Fatalf("bad hook response: %d %q", code, output)
				}
				return reply
			}
			key, command := agent, "mex compact"
			if agent == "codex" {
				real, err := place.RealPath(checkout)
				if err != nil {
					t.Fatal(err)
				}
				key += "." + place.ShortHash(real)
				command += " --agent codex"
			}
			send("SessionStart", checkout, "first")
			if !waitingCompactOffers(h.mex) {
				t.Fatal("session start did not request a qualification check")
			}
			if reply := send("UserPromptSubmit", checkout, "first"); reply["systemMessage"] != nil {
				t.Fatalf("notice without qualification: %s", reply["systemMessage"])
			}
			path := filepath.Join(h.mex, "compaction-offers", key)
			write(t, path, "1\n")
			if agent == "codex" {
				if reply := send("SessionStart", other, "other"); reply["systemMessage"] != nil {
					t.Fatalf("notice escaped its qualifying checkout: %s", reply["systemMessage"])
				}
			}
			reply := send("UserPromptSubmit", checkout, "first")
			if !strings.Contains(string(reply["systemMessage"]), command+" to review the offer") ||
				strings.Contains(string(reply["hookSpecificOutput"]), "to review the offer") {
				t.Fatalf("expected a person-only offer: %v", reply)
			}
			write(t, path, "1\n")
			if reply := send("SessionStart", checkout, "second"); reply["systemMessage"] != nil {
				t.Fatalf("notice repeated in another session: %s", reply["systemMessage"])
			}
		})
	}
}
