package index

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mex-memory/mex/native/index/shift"
)

const codeFilesWhere = "reason IS NULL AND hash IS NOT NULL AND lang IS NOT NULL AND lang <> 'other'"

// Reads the code graph needs from the file index: which files the hook has
// edited since their parse, test flags that hold while a file is edited, and
// every indexed code file with its parsed hash.

// Edited reports a file the hook has shifted since its parse: its outline
// still holds (moved through the shifts), but its hash is the parsed one, so
// it is not the content anything built from that hash saw.
func (r *Reader) Edited(path string) bool {
	rel, row, miss := r.row(path)
	if miss != nil {
		return false
	}
	return len(shiftsFor(r, rel, row.mtime)) > 0
}

// TestFlag is whether the index classed a file as a test. It reads the flag
// even while the file is being edited, since a test stays a test.
func (r *Reader) TestFlag(path string) (isTest, known bool) {
	_, row, miss := r.row(path)
	if miss != nil {
		return false, false
	}
	return row.isTest == 1, true
}

// CodeFiles lists every indexed code file (a file with a language other than
// "other": docs and config are never code), with the hash it was parsed at. A file edited since its parse, or (with disk) changed on
// disk some other way, lists with an empty hash: its content is unknown here.
func (r *Reader) CodeFiles(disk bool) (map[string]string, error) {
	rows, err := r.db.Query("SELECT path,hash,mtime_ns FROM paths WHERE " + codeFilesWhere)
	if err != nil {
		return nil, err
	}
	type file struct{ path, hash, mtime string }
	var list []file
	for rows.Next() {
		var f file
		if err := rows.Scan(&f.path, &f.hash, &f.mtime); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, f)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// One listing of the shifts, then the per-file checks in parallel: a
	// large checkout has tens of thousands of files to stat.
	shifted := shift.ShiftedPaths(r.directory, r.key)
	unknown := make([]bool, len(list))
	workers := runtime.GOMAXPROCS(0)
	if workers > 8 {
		workers = 8
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := w; i < len(list); i += workers {
				f := list[i]
				var pending []shift.Shift
				if shifted.Has(f.path) {
					pending = shiftsFor(r, f.path, f.mtime)
				}
				unknown[i] = len(pending) > 0 || disk && r.changedOnDisk(f.path, f.mtime, pending)
			}
		}(w)
	}
	wg.Wait()
	out := make(map[string]string, len(list))
	for i, f := range list {
		if unknown[i] {
			f.hash = ""
		}
		out[f.path] = f.hash
	}
	return out, nil
}

// RecentlyChanged checks for a recent write newer than the parse and outside
// the edits the hook already recorded.
func (r *Reader) RecentlyChanged(path string, since time.Time, maxBytes int64) bool {
	rel, row, miss := r.row(path)
	if miss != nil {
		return false
	}
	info, err := os.Lstat(filepath.Join(r.root, filepath.FromSlash(rel)))
	return err == nil && recentFile(info, since) && info.Size() <= maxBytes && r.newerWrite(rel, row.mtime, info.ModTime())
}

func recentFile(info os.FileInfo, since time.Time) bool {
	return info.Mode().IsRegular() && !info.ModTime().Before(since)
}

func (r *Reader) newerWrite(rel, parsed string, modified time.Time) bool {
	mtime, err := strconv.ParseInt(parsed, 10, 64)
	if err != nil || modified.UnixNano() <= mtime {
		return false
	}
	for _, sh := range shiftsFor(r, rel, parsed) {
		if sh.MtimeNS == strconv.FormatInt(modified.UnixNano(), 10) {
			return false
		}
	}
	return true
}

// MaxRecentCodeCandidates bounds the unique indexed files a shell event can check.
const MaxRecentCodeCandidates = 4096

// RecentCodeFile carries the observed version so the session can recognize it
// when a subsequent command leaves it untouched.
type RecentCodeFile struct {
	Path  string
	Mtime int64
}

// RecentlyChangedCode checks checkout-relative targets against the paths
// index before touching disk. Targets may name files or directories. A
// trailing slash means directory only, and "." names the checkout itself.
// Session files are looked up by exact path. A partial scan yields no changes.
func (r *Reader) RecentlyChangedCode(ctx context.Context, targets, files []string, since, now time.Time, limit int, observed map[string]int64) ([]RecentCodeFile, bool) {
	if ctx.Err() != nil || len(targets)+len(files) > MaxRecentCodeCandidates {
		return nil, false
	}
	candidates, ok := r.recentCodeCandidates(ctx, targets, files)
	if !ok || len(candidates) == 0 {
		return nil, ok
	}
	stats, err := openCandidateStats(r.root)
	if err != nil {
		return nil, false
	}
	defer stats.Close()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	workers := min((len(candidates)+31)/32, runtime.GOMAXPROCS(0), 8)
	results := make([][]RecentCodeFile, workers)
	var count atomic.Int32
	var wg sync.WaitGroup
	scan := func(worker int) {
		for i := worker; i < len(candidates) && ctx.Err() == nil; i += workers {
			file := candidates[i]
			modified, err := stats.mtime(file.path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				cancel()
				return
			}
			if modified.IsZero() || modified.Before(since) || modified.After(now) {
				continue
			}
			mtime := modified.UnixNano()
			if observed[file.path] == mtime || !r.newerWrite(file.path, file.parsed, modified) {
				continue
			}
			if int(count.Add(1)) > limit {
				cancel()
				return
			}
			results[worker] = append(results[worker], RecentCodeFile{Path: file.path, Mtime: mtime})
		}
	}
	for worker := 1; worker < workers; worker++ {
		wg.Go(func() { scan(worker) })
	}
	scan(0)
	wg.Wait()
	if ctx.Err() != nil {
		return nil, false
	}
	var changed []RecentCodeFile
	for _, result := range results {
		changed = append(changed, result...)
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].Path < changed[j].Path })
	return changed, true
}

type indexedCodeCandidate struct{ path, parsed string }

func (r *Reader) recentCodeCandidates(ctx context.Context, targets, files []string) ([]indexedCodeCandidate, bool) {
	const selectCode = "SELECT path,mtime_ns FROM paths WHERE " + codeFilesWhere + " AND "
	seen := map[string]bool{}
	var candidates []indexedCodeCandidate
	query := func(where string, args ...any) bool {
		rows, err := r.db.QueryContext(ctx, selectCode+where, args...)
		if err != nil {
			return false
		}
		defer rows.Close()
		for rows.Next() {
			var file indexedCodeCandidate
			if rows.Scan(&file.path, &file.parsed) != nil {
				return false
			}
			name := filepath.FromSlash(file.path)
			if !filepath.IsLocal(name) || filepath.Clean(name) != name || name == "." {
				return false
			}
			if seen[file.path] {
				continue
			}
			if len(candidates) == MaxRecentCodeCandidates {
				return false
			}
			seen[file.path] = true
			candidates = append(candidates, file)
		}
		return rows.Err() == nil
	}
	whole := false
	for _, target := range targets {
		if !filepath.IsLocal(filepath.FromSlash(target)) {
			continue
		}
		if target == "." {
			whole = true // after the named files, and only if it fits
			continue
		}
		dir := strings.TrimSuffix(target, "/")
		if dir == target && !seen[target] && !query("path=?", target) {
			return nil, false
		}
		// In the paths primary key's binary order, '/' sorts just before '0'.
		if !query("path>=? AND path<?", dir+"/", dir+"0") {
			return nil, false
		}
	}
	for _, file := range files {
		if filepath.IsLocal(filepath.FromSlash(file)) && !seen[file] && !query("path=?", file) {
			return nil, false
		}
	}
	// A command can name the whole checkout in passing (a bare "." or a
	// root glob). On a large checkout that is past the cap: check what the
	// command names more precisely instead of giving up on all of it.
	if whole {
		var total int
		if err := r.db.QueryRowContext(ctx, "SELECT count(*) FROM paths WHERE "+codeFilesWhere).Scan(&total); err != nil {
			return nil, false
		}
		if total <= MaxRecentCodeCandidates && !query("1") {
			return nil, false
		}
	}
	return candidates, ctx.Err() == nil
}

func shiftsFor(r *Reader, rel, mtime string) []shift.Shift {
	return shift.Pending(r.directory, r.key, rel, mtime)
}
