package capture

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// gitTimeout bounds each git call. They run only at session start, and only
// when there is something to show.
const gitTimeout = 800 * time.Millisecond

// readSmall reads a small regular file, refusing links and large files.
func readSmall(path string, max int64) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return "", errors.New("not a small regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(data)) > max {
		return "", errors.New("not a small regular file")
	}
	return string(data), nil
}

// gitDirs finds a checkout's git folder and, for a linked worktree, the
// common folder that holds shared refs. Plain file reads: no git process.
func gitDirs(checkout string) (dir, common string, ok bool) {
	dotgit := filepath.Join(checkout, ".git")
	info, err := os.Lstat(dotgit)
	if err != nil {
		return "", "", false
	}
	switch {
	case info.IsDir():
		dir = dotgit
	case info.Mode().IsRegular():
		text, err := readSmall(dotgit, 4096)
		if err != nil {
			return "", "", false
		}
		path, found := strings.CutPrefix(strings.TrimSpace(text), "gitdir:")
		if !found {
			return "", "", false
		}
		path = strings.TrimSpace(path)
		if !filepath.IsAbs(path) {
			path = filepath.Join(checkout, path)
		}
		dir = filepath.Clean(path)
	default:
		return "", "", false
	}
	common = dir
	if text, err := readSmall(filepath.Join(dir, "commondir"), 4096); err == nil {
		c := strings.TrimSpace(text)
		if !filepath.IsAbs(c) {
			c = filepath.Join(dir, c)
		}
		common = filepath.Clean(c)
	}
	return dir, common, true
}

// Branch is the checked-out branch, or "" on a detached HEAD or no git.
func Branch(checkout string) string {
	dir, _, ok := gitDirs(checkout)
	if !ok {
		return ""
	}
	head, err := readSmall(filepath.Join(dir, "HEAD"), 4096)
	if err != nil {
		return ""
	}
	ref, found := strings.CutPrefix(strings.TrimSpace(head), "ref: refs/heads/")
	if !found || ref == "" || strings.ContainsAny(ref, "\x00\n") {
		return ""
	}
	return ref
}

// Head is the commit the branch points at, from loose or packed refs, or "".
func Head(checkout, branch string) string {
	dir, common, ok := gitDirs(checkout)
	if !ok || branch == "" {
		return ""
	}
	ref := "refs/heads/" + branch
	for _, base := range []string{dir, common} {
		if text, err := readSmall(filepath.Join(base, filepath.FromSlash(ref)), 256); err == nil {
			if sha := strings.TrimSpace(text); isSHA(sha) {
				return sha
			}
		}
	}
	f, err := os.Open(filepath.Join(common, "packed-refs"))
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, 32<<20))
	for scanner.Scan() {
		line := scanner.Text()
		if sha, name, found := strings.Cut(line, " "); found && name == ref && isSHA(sha) {
			return sha
		}
	}
	return ""
}

func isSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// git runs a read-only git command in the checkout. Optional locks are off,
// so `status` never rewrites the index under the person's feet.
func git(checkout string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", checkout}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	out, err := cmd.Output()
	return string(out), err
}

// Uncommitted lists changed and untracked file names, at most limit of them,
// and how many there are in all. ok is false when git couldn't say.
func Uncommitted(checkout string, limit int) (names []string, total int, ok bool) {
	out, err := git(checkout, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return nil, 0, false
	}
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		p := parts[i]
		if len(p) < 4 {
			continue
		}
		name := p[3:]
		if p[0] == 'R' || p[0] == 'C' {
			i++ // the rename's source follows
		}
		total++
		if len(names) < limit {
			names = append(names, name)
		}
	}
	return names, total, true
}

// defaultBranch is the remote's default branch, else a local main or master.
func defaultBranch(checkout string) (ref, name string) {
	if out, err := git(checkout, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		r := strings.TrimSpace(out)
		return r, strings.TrimPrefix(r, "refs/remotes/origin/")
	}
	for _, n := range []string{"main", "master"} {
		if _, err := git(checkout, "rev-parse", "--verify", "--quiet", "refs/heads/"+n); err == nil {
			return "refs/heads/" + n, n
		}
	}
	return "", ""
}

// Merged reports whether the branch's commit is already in the default
// branch. A branch with no commits of its own counts as not merged.
func Merged(checkout, branch, head string) bool {
	ref, name := defaultBranch(checkout)
	if ref == "" || name == branch || head == "" {
		return false
	}
	if out, err := git(checkout, "rev-parse", "--verify", "--quiet", ref); err == nil && strings.TrimSpace(out) == head {
		return false // nothing on the branch yet
	}
	// A branch still at the commit it was created on has nothing of its own
	// to merge, even after the default branch moves on.
	if out, err := git(checkout, "reflog", "show", "--format=%H", "refs/heads/"+branch, "--"); err == nil {
		lines := strings.Fields(out)
		if len(lines) > 0 && lines[len(lines)-1] == head {
			return false
		}
	}
	_, err := git(checkout, "merge-base", "--is-ancestor", head, ref)
	return err == nil
}
