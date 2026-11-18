package delivery

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

func TestSetupRefreshIsAskedAtMostOncePerWindow(t *testing.T) {
	dir, checkout, now := t.TempDir(), filepath.Join(t.TempDir(), "repo"), time.Now()
	request := filepath.Join(dir, RefreshPendingFolder, place.ShortHash(checkout)+".json")
	if err := RequestSetupRefresh(dir, "g-0123456789abcdef01234567", checkout, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(request); err != nil {
		t.Fatal("no request written", err)
	}
	// Node took the request and stamped the checkout: no new request inside the window.
	if err := os.Remove(request); err != nil {
		t.Fatal(err)
	}
	stamp := filepath.Join(dir, RefreshStampFolder, place.ShortHash(checkout))
	if err := os.MkdirAll(filepath.Dir(stamp), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stamp, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = RequestSetupRefresh(dir, "g-0123456789abcdef01234567", checkout, now.Add(RefreshEvery/2))
	if _, err := os.Stat(request); err == nil {
		t.Fatal("asked again inside the window")
	}
	_ = RequestSetupRefresh(dir, "g-0123456789abcdef01234567", checkout, now.Add(RefreshEvery+time.Minute))
	if _, err := os.Stat(request); err != nil {
		t.Fatal("not asked after the window", err)
	}
}
