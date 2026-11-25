package capture

import (
	"strconv"
	"strings"
)

// A branch note is tied to the position where the person typed it.
type NoteBranch struct {
	Name         string `json:"name"`
	Head         string `json:"head"`
	UnmergedHead string `json:"unmerged_head"`
}

type NoteBranchState struct {
	Matches      bool   `json:"matches"`
	UnmergedHead string `json:"unmerged_head"`
	Merged       bool   `json:"merged"`
	Tip          string `json:"tip"`
}

// NoteBranchStates uses the same merge and fork-point test as continuity.
// A deleted or rewritten branch can be retired if its last observed
// unmerged tip is now on the default branch.
func NoteBranchStates(checkout string, branches []NoteBranch) []NoteBranchState {
	states := make([]NoteBranchState, len(branches))
	if len(branches) == 0 {
		return states
	}
	ref, defaultName := defaultBranch(checkout)
	tips := make(map[string]string)
	type landing struct {
		merged, unmerged bool
	}
	landings := make(map[string]landing)
	for i, source := range branches {
		if !isSHA(source.Head) || source.Name == "" || len(source.Name) > 1024 {
			continue
		}
		key := "refs/heads/" + source.Name
		tip, checked := tips[key]
		if !checked {
			if _, err := git(checkout, "check-ref-format", key); err == nil {
				resolved, _ := git(checkout, "rev-parse", "--verify", "--quiet", key+"^{commit}")
				tip = strings.TrimSpace(resolved)
				if !isSHA(tip) {
					tip = ""
				}
			}
			tips[key] = tip
		}
		matches := tip == source.Head
		if !matches && tip != "" {
			matches, _ = ancestor(checkout, source.Head, tip)
		}
		state := NoteBranchState{Matches: matches, Tip: tip}
		if isSHA(source.UnmergedHead) {
			state.UnmergedHead = source.UnmergedHead
		}
		if ref != "" && defaultName != source.Name {
			if matches {
				landed, checked := landings[key]
				if !checked {
					onDefault, known := ancestor(checkout, tip, ref)
					landed = landing{merged: onDefault && mergedInto(checkout, source.Name, tip, ref, defaultName), unmerged: known && !onDefault}
					landings[key] = landed
				}
				state.Merged = landed.merged
				if landed.unmerged {
					state.UnmergedHead = tip
				}
			} else if state.UnmergedHead != "" {
				state.Merged, _ = ancestor(checkout, state.UnmergedHead, ref)
			}
		}
		states[i] = state
	}
	return states
}

type NoteReleaseTag struct {
	Name string `json:"name"`
	Time int64  `json:"time"`
}

// NoteReleaseTags reads only local refs pointing at commits, including both
// annotated and lightweight tags. A failed or capped read has no baseline.
func NoteReleaseTags(checkout string) []NoteReleaseTag {
	out, err := git(checkout, "for-each-ref", "--format=%(objecttype)%00%(*objecttype)%00%(creatordate:unix)%00%(refname:strip=2)", "refs/tags")
	if err != nil {
		return nil
	}
	tags := []NoteReleaseTag{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(strings.TrimSuffix(line, "\r"), "\x00", 4)
		if len(fields) == 4 && (fields[0] == "commit" || fields[1] == "commit") {
			seconds, err := strconv.ParseInt(fields[2], 10, 64)
			if err == nil && seconds >= 0 && seconds <= 8_640_000_000_000 {
				tags = append(tags, NoteReleaseTag{Name: fields[3], Time: seconds * 1000})
			}
		}
	}
	return tags
}
