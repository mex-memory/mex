package scope

import (
	"runtime"
	"testing"
)

func TestMatchesScopeNormalizesSlashes(t *testing.T) {
	if !MatchesScope("src/**", `src\api.ts`) {
		t.Fatal("a backslash path is the same file")
	}
	if MatchesScope("src/**", `other\api.ts`) {
		t.Fatal("a different folder still misses")
	}
}

func TestMatchesScopeFoldsCaseOnWindows(t *testing.T) {
	matched := MatchesScope("src/**", "Src/Api.ts")
	if windows := runtime.GOOS == "windows"; matched != windows {
		t.Fatalf("case fold on windows=%t, matched=%t", windows, matched)
	}
}
