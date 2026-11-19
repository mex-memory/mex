package pattern

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The saved review set: review comments from a public repository where the
// commented code changed later in the same pull request, so both the code
// the reviewer objected to and the fix are known. Each case carries the
// patterns a learner might propose, labelled by hand: good when the pattern
// names what the reviewer objected to. See testdata/README.md.
type reviewCase struct {
	Source     string `json:"source"`
	Objected   string `json:"objected"`
	Fixed      string `json:"fixed"`
	Candidates []struct {
		Type    string `json:"type"`
		Match   string `json:"match"`
		Pattern string `json:"pattern"`
		Good    bool   `json:"good"`
		Why     string `json:"why"`
	} `json:"candidates"`
}

// Floors for the self-check on the review set, set from the measured
// result. Without area files only the objected/fixed rule runs. With
// MEX_REVIEW_SET_AREAS naming a folder of <case index>/ subfolders (each
// case's package at the pull request's head: the area as it is once the
// fix has merged, which is when MEX learns from a review), the share rule
// runs too. The area files are public code too large to keep in the repo.
var (
	reviewSetFloor     = [2]float64{0.60, 1.00} // precision, recall: objected/fixed only
	reviewSetAreaFloor = [2]float64{0.60, 0.85} // with the area share
)

func reviewArea(t *testing.T, dir string, i int) Area {
	if dir == "" {
		return Area{}
	}
	files, err := os.ReadDir(filepath.Join(dir, strconv.Itoa(i)))
	if err != nil {
		t.Fatalf("area %d: %v", i, err)
	}
	area := Area{}
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(dir, strconv.Itoa(i), f.Name()))
		if err != nil {
			t.Fatal(err)
		}
		area = append(area, string(data))
	}
	return area
}

func TestSelfCheckPrecisionOnTheReviewSet(t *testing.T) {
	data, err := os.ReadFile("testdata/review-set.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []reviewCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	areas := os.Getenv("MEX_REVIEW_SET_AREAS")
	floor := reviewSetFloor
	if areas != "" {
		floor = reviewSetAreaFloor
	}
	var kept, keptGood, good int
	for i, rc := range cases {
		area := reviewArea(t, areas, i)
		for _, c := range rc.Candidates {
			if c.Good {
				good++
				// A good label must at least describe the objected code;
				// otherwise the fixture is wrong, not the self-check.
				m, err := Matcher(c.Match, c.Pattern)
				target := rc.Objected
				if c.Type == "required" {
					target = rc.Fixed
				}
				if err != nil || !m(target) {
					t.Fatalf("%s: good pattern %q doesn't match its code", rc.Source, c.Pattern)
				}
			}
			v := SelfCheck(Candidate{Type: c.Type, Match: c.Match, Pattern: c.Pattern, Objected: rc.Objected, Fixed: rc.Fixed}, area)
			if v.Keep {
				kept++
				if c.Good {
					keptGood++
				} else {
					t.Logf("kept a bad pattern: %s %q (%s)", rc.Source, c.Pattern, c.Why)
				}
			} else if c.Good {
				t.Logf("dropped a good pattern: %s %q: %s", rc.Source, c.Pattern, v.Reason)
			} else if areas != "" {
				t.Logf("dropped a bad pattern: %s %q: %s", rc.Source, c.Pattern, v.Reason)
			}
		}
	}
	precision, recall := float64(keptGood)/float64(kept), float64(keptGood)/float64(good)
	t.Logf("review set (areas %v): %d cases; kept %d of %d candidates; precision %d/%d = %.2f; recall %d/%d = %.2f",
		areas != "", len(cases), kept, countCandidates(cases), keptGood, kept, precision, keptGood, good, recall)
	if precision < floor[0] || recall < floor[1] {
		t.Fatalf("precision %.2f (floor %.2f), recall %.2f (floor %.2f)", precision, floor[0], recall, floor[1])
	}
}

func countCandidates(cases []reviewCase) int {
	n := 0
	for _, rc := range cases {
		n += len(rc.Candidates)
	}
	return n
}
