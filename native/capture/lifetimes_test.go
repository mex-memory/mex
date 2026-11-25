package capture

import "testing"

func TestNoteBranchStates(t *testing.T) {
	root := captureRepo(t)
	branch := "feat/capture"
	fork := NoteBranch{Name: branch, Head: Head(root, branch)}
	check := func(source NoteBranch, matches, merged bool, unmergedHead string) {
		t.Helper()
		got := NoteBranchStates(root, []NoteBranch{source})[0]
		if got.Matches != matches || got.UnmergedHead != unmergedHead || got.Merged != merged {
			t.Fatalf("branch %s: got %+v, want matches=%t unmergedHead=%s merged=%t", source.Name, got, matches, unmergedHead, merged)
		}
	}
	check(fork, true, false, "")

	captureGit(t, root, "commit", "-q", "--allow-empty", "-m", "first feature change")
	source := NoteBranch{Name: branch, Head: Head(root, branch)}
	check(source, true, false, source.Head)
	source.UnmergedHead = source.Head
	captureGit(t, root, "commit", "-q", "--allow-empty", "-m", "second feature change")
	tip := Head(root, branch)
	captureGit(t, root, "switch", "-q", "main")
	captureGit(t, root, "merge", "--ff-only", source.Head)
	check(source, true, false, tip)
	source.UnmergedHead = tip
	// Disappearance alone proves nothing, even when an earlier commit landed.
	captureGit(t, root, "branch", "-D", branch)
	check(source, false, false, tip)
	captureGit(t, root, "merge", "--ff-only", tip)
	check(source, false, true, tip)
	check(fork, false, false, "")
}

func TestNoteReleaseTags(t *testing.T) {
	root := captureRepo(t)
	captureGit(t, root, "tag", "v1.0.0")
	captureGit(t, root, "tag", "-a", "v1.1.0", "-m", "release")
	blob := captureGit(t, root, "rev-parse", "HEAD:README.md")
	captureGit(t, root, "tag", "v9.0.0", blob)
	tags := NoteReleaseTags(root)
	if len(tags) != 2 || tags[0].Name != "v1.0.0" || tags[1].Name != "v1.1.0" || tags[0].Time <= 0 || tags[1].Time <= 0 {
		t.Fatalf("unexpected tags: %+v", tags)
	}
}
