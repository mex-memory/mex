package capture

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// gitTimeout bounds a capture metadata read. Worktree patches share their
// caller's deadline across all Git reads.
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

// git reads metadata without invoking configured monitors, hooks, pagers,
// signature verifiers or network helpers. Inherited Git routing and command
// configuration cannot redirect the read. Status also checks for content
// filters below, since those cannot be disabled with one fixed config key.
func git(checkout string, args ...string) (string, error) {
	return gitInput(checkout, "", args...)
}

func gitInput(checkout, input string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	return gitInputContext(ctx, checkout, input, args...)
}

func gitInputContext(ctx context.Context, checkout, input string, args ...string) (string, error) {
	prefix := []string{"--no-pager", "--no-replace-objects", "--literal-pathspecs", "-C", checkout,
		"-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + os.DevNull,
		"-c", "log.showSignature=false", "-c", "submodule.recurse=false",
		"-c", "protocol.allow=never", "-c", "maintenance.auto=false", "-c", "gc.auto=0"}
	cmd := exec.CommandContext(ctx, "git", append(prefix, args...)...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		// Keep the user's config locations for author identity and filter
		// detection, but discard injected config, routing and trace sinks.
		if strings.HasPrefix(strings.ToUpper(key), "GIT_") && key != "GIT_CONFIG_GLOBAL" && key != "GIT_CONFIG_SYSTEM" && key != "GIT_CONFIG_NOSYSTEM" {
			continue
		}
		cmd.Env = append(cmd.Env, value)
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1", "GIT_ALLOW_PROTOCOL=", "LC_ALL=C")
	out := &gitOutput{}
	cmd.Stdout = out
	err := cmd.Run()
	if out.exceeded {
		return "", errors.New("git metadata exceeds its limit")
	}
	return out.buffer.String(), err
}

// Bound history, status and raw object reads before buffering their output.
type gitOutput struct {
	buffer   bytes.Buffer
	exceeded bool
}

func (b *gitOutput) Write(p []byte) (int, error) {
	if len(p) > (1<<20)-b.buffer.Len() {
		b.exceeded = true
		return 0, errors.New("git metadata exceeds its limit")
	}
	return b.buffer.Write(p)
}

// Uncommitted lists changed and untracked file names, at most limit of them,
// and how many there are in all. ok is false when git couldn't say.
func Uncommitted(checkout string, limit int) (names []string, total int, ok bool) {
	// Inspecting submodule dirtiness would run Git inside another repo with
	// its own filters. Do not report that uninspected tree as clean either.
	index, err := git(checkout, "ls-files", "--stage", "-z")
	if err != nil {
		return nil, 0, false
	}
	var paths strings.Builder
	for _, entry := range strings.Split(index, "\x00") {
		if entry == "" {
			continue
		}
		if strings.HasPrefix(entry, "160000 ") {
			return nil, 0, false
		}
		_, path, found := strings.Cut(entry, "\t")
		if !found {
			return nil, 0, false
		}
		paths.WriteString(path)
		paths.WriteByte(0)
	}
	// Installed tools often register filters globally even in repositories
	// that never use them. Only active filters on tracked paths can execute
	// during status. check-attr reads attributes without running the filters.
	if !statusFiltersSafe(func(input string, args ...string) (string, error) {
		return gitInput(checkout, input, args...)
	}, paths.String()) {
		return nil, 0, false
	}
	out, err := git(checkout, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all")
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

func statusFiltersSafe(run func(string, ...string) (string, error), paths string) bool {
	filters, err := run("", "config", "--includes", "--null", "--name-only", "--get-regexp", `^filter\..*\.(clean|process)$`)
	if err != nil {
		var exit *exec.ExitError
		return filters == "" && errors.As(err, &exit) && exit.ExitCode() == 1
	}
	drivers := map[string]bool{}
	for _, key := range strings.Split(filters, "\x00") {
		if key == "" {
			continue
		}
		name := strings.TrimPrefix(key, "filter.")
		name = name[:strings.LastIndexByte(name, '.')]
		drivers[name] = true
	}
	if paths == "" {
		return true
	}
	attributes, err := run(paths, "check-attr", "-z", "--stdin", "filter")
	if err != nil || !strings.HasSuffix(attributes, "\x00") {
		return false
	}
	fields := strings.Split(strings.TrimSuffix(attributes, "\x00"), "\x00")
	if len(fields)%3 != 0 {
		return false
	}
	for i := 0; i < len(fields); i += 3 {
		if fields[i+1] != "filter" || drivers[fields[i+2]] {
			return false
		}
	}
	return true
}

// WorktreePatch reads a zero-context diff for the named files. Files outside
// Git's index, or in a checkout with an unborn HEAD, have no patch baseline.
func WorktreePatch(ctx context.Context, checkout string, paths []string) (patch string, whole []string, ok bool) {
	if _, _, ok := gitDirs(checkout); !ok {
		return "", nil, false
	}
	run := func(input string, args ...string) (string, error) {
		return gitInputContext(ctx, checkout, input, args...)
	}
	listed, err := run("", append([]string{"ls-files", "--cached", "-z", "--"}, paths...)...)
	if err != nil {
		return "", nil, false
	}
	known := map[string]bool{}
	for _, path := range strings.Split(listed, "\x00") {
		known[path] = true
	}
	var tracked []string
	for _, path := range paths {
		if known[path] {
			tracked = append(tracked, path)
		} else {
			whole = append(whole, path)
		}
	}
	if len(tracked) == 0 {
		return "", whole, true
	}
	if !statusFiltersSafe(run, strings.Join(tracked, "\x00")+"\x00") {
		return "", nil, false
	}
	args := []string{"diff", "-U0", "--inter-hunk-context=0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
		"--ignore-submodules=all", "--no-relative", "--word-diff=none", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--"}
	patch, err = run("", append(args, tracked...)...)
	if err == nil {
		return patch, whole, true
	}
	// Distinguish an unborn branch from a broken index, failed diff, or
	// unavailable Git. show-ref --exists returns 2 for a missing ref.
	ref, err := run("", "symbolic-ref", "--quiet", "HEAD")
	if err == nil && strings.HasPrefix(ref, "refs/heads/") {
		_, err = run("", "show-ref", "--exists", strings.TrimSpace(ref))
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 2 {
			return "", paths, true
		}
	}
	return "", nil, false
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
