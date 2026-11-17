package delivery

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

// NativePendingFolder holds one small request per checkout whose MEX rule
// files carry a note the code has changed or broken. Node, the only writer of
// the job table, turns each request into a rule-file rebuild.
const NativePendingFolder = "native-pending"

var errNativeRedirected = errors.New("native-pending folder is redirected")

// RequestNativeRebuild writes the checkout's request atomically under the
// record directory. It refuses symlinked folders and never touches Node's
// tables. Callers ignore errors: a later start asks again.
func RequestNativeRebuild(recordDirectory, projectID, checkout string) error {
	return writePendingRequest(recordDirectory, NativePendingFolder, projectID, checkout)
}

// RefreshPendingFolder holds one request per checkout to re-read what setup
// read (package files, rule files, the agents' own memory) so additions reach
// the agents without anyone running mex again. RefreshStampFolder holds the
// time of each checkout's last request, which Node touches when it queues one.
const (
	RefreshPendingFolder = "refresh-pending"
	RefreshStampFolder   = "refresh-stamps"
	RefreshEvery         = 30 * time.Minute
)

// RequestSetupRefresh asks for that re-read at most once per RefreshEvery per
// checkout: one stat when it is too soon, else one small file write.
func RequestSetupRefresh(recordDirectory, projectID, checkout string, now time.Time) error {
	if recordDirectory == "" || checkout == "" {
		return errNativeRedirected
	}
	name := place.ShortHash(checkout)
	if info, err := os.Stat(filepath.Join(recordDirectory, RefreshStampFolder, name)); err == nil && now.Sub(info.ModTime()) < RefreshEvery {
		return nil
	}
	if _, err := os.Stat(filepath.Join(recordDirectory, RefreshPendingFolder, name+".json")); err == nil {
		return nil
	}
	return writePendingRequest(recordDirectory, RefreshPendingFolder, projectID, checkout)
}

func writePendingRequest(recordDirectory, folder, projectID, checkout string) error {
	if recordDirectory == "" || projectID == "" || checkout == "" {
		return errNativeRedirected
	}
	data, err := json.Marshal(map[string]any{"version": 1, "project_id": projectID, "checkout": checkout})
	if err != nil || len(data) > 16<<10 {
		return errNativeRedirected
	}
	root, err := os.OpenRoot(recordDirectory)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.MkdirAll(folder, 0o700); err != nil {
		return err
	}
	info, err := root.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errNativeRedirected
	}
	tmp := filepath.Join(folder, ".request-"+rand.Text())
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(tmp, filepath.Join(folder, place.ShortHash(checkout)+".json"))
}
