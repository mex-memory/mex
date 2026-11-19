package capture

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	compactionPendingDir = "compaction-pending"
	compactionTTL        = 10 * time.Minute
	compactionFileLimit  = 8 << 10
)

func compactionScope(ev contract.Event) string {
	return place.ShortHash(strings.Join([]string{ev.Agent, ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout}, "\x00"))
}

func compactionFolder(ev contract.Event) string {
	return filepath.Join(compactionPendingDir, compactionScope(ev))
}

type pendingCompaction struct {
	Epoch int       `json:"epoch"`
	At    time.Time `json:"at"`
	Text  string    `json:"text"`
}

// StageCompactionRecovery bridges two hook processes. The score is recorded
// separately; only the short rendered block waits here, never the summary.
func StageCompactionRecovery(ev contract.Event, env Env, epoch int, text string) error {
	if text == "" || len(text) > compactionFileLimit/2 {
		return nil
	}
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.MkdirAll(compactionPendingDir, 0o700); err != nil {
		return err
	}
	if info, err := root.Lstat(compactionPendingDir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errRedirected
	}
	return filterFile(env.RecordDirectory, compactionFolder(ev), strconv.Itoa(epoch),
		pendingCompaction{Epoch: epoch, At: now(env).UTC(), Text: text})
}

// CompactionPending keeps the normal prompt path off SQLite. A pending block
// can also be delivered on a prompt if PostCompact followed SessionStart.
func CompactionPending(ev contract.Event, directory string) bool {
	info, err := os.Lstat(filepath.Join(directory, compactionFolder(ev)))
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

// ReadCompactionRecovery only reads the pending text for the caller's scope
// and current epoch. Delete is a separate step after the delivery claim.
func ReadCompactionRecovery(ev contract.Event, env Env, epoch int) string {
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return ""
	}
	defer root.Close()
	folder := compactionFolder(ev)
	for _, path := range []string{compactionPendingDir, folder} {
		info, err := root.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ""
		}
	}
	path := filepath.Join(folder, strconv.Itoa(epoch)+".json")
	before, err := root.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > compactionFileLimit {
		return ""
	}
	f, err := root.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return ""
	}
	raw, err := io.ReadAll(io.LimitReader(f, compactionFileLimit+1))
	var pending pendingCompaction
	if err != nil || len(raw) > compactionFileLimit || json.Unmarshal(raw, &pending) != nil ||
		pending.Epoch != epoch || pending.At.After(now(env)) || now(env).Sub(pending.At) >= compactionTTL {
		return ""
	}
	return pending.Text
}

func ClearCompactionRecovery(ev contract.Event, env Env, epoch int) {
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return
	}
	defer root.Close()
	folder := compactionFolder(ev)
	for _, path := range []string{compactionPendingDir, folder} {
		info, err := root.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return
		}
	}
	_ = root.Remove(filepath.Join(folder, strconv.Itoa(epoch)+".json"))
	_ = root.Remove(folder) // only if empty
}

func pruneCompactionRecovery(env Env) {
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return
	}
	defer root.Close()
	info, err := root.Lstat(compactionPendingDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return
	}
	directory, err := root.Open(compactionPendingDir)
	if err != nil {
		return
	}
	defer directory.Close()
	scopes, err := directory.ReadDir(32)
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	for _, scope := range scopes {
		if decoded, err := hex.DecodeString(scope.Name()); err != nil || len(decoded) != 12 {
			continue
		}
		folder := filepath.Join(compactionPendingDir, scope.Name())
		info, err := scope.Info()
		if err != nil || !info.IsDir() || now(env).Sub(info.ModTime()) < compactionTTL {
			continue
		}
		f, err := root.Open(folder)
		if err != nil {
			continue
		}
		files, _ := f.ReadDir(16)
		_ = f.Close()
		for _, file := range files {
			epoch, ok := strings.CutSuffix(file.Name(), ".json")
			if _, err := strconv.Atoi(epoch); (!ok || err != nil) && !strings.HasPrefix(file.Name(), ".request-") {
				continue
			}
			if stat, err := file.Info(); err == nil && stat.Mode().IsRegular() && now(env).Sub(stat.ModTime()) >= compactionTTL {
				_ = root.Remove(filepath.Join(folder, file.Name()))
			}
		}
		_ = root.Remove(folder)
	}
}
