package delivery

import (
	"testing"

	"github.com/mex-memory/mex/native/record"
)

// Both arms of the start-brief trial occur, by a stable per-session hash.
func TestStartBriefArmsSplitSessions(t *testing.T) {
	arms := map[string]int{}
	for i := 0; i < 200; i++ {
		session := "s" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		a := record.TrialArm(session, "", workingSetSurface)
		if a != record.TrialArm(session, "", workingSetSurface) {
			t.Fatal("unstable arm")
		}
		arms[a]++
	}
	if arms["on"] < 70 || arms["shadow"] < 70 {
		t.Fatal(arms)
	}
	if record.SurfaceDefault(workingSetSurface) != "trial" || !record.OncePerSession(workingSetSurface) {
		t.Fatal("default")
	}
}
