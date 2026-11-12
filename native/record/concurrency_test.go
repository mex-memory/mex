package record

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type writerSummary struct {
	Calls int
	MaxNS int64
}

func TestConcurrentHookWriters(t *testing.T) {
	location := testLocation(t)
	hooks, err := OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	hooks.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	barrier := t.TempDir()
	type peer struct {
		cmd    *exec.Cmd
		output *bytes.Buffer
		name   string
	}
	peers := []peer{}
	for _, name := range []string{"a", "b", "c"} {
		cmd := exec.Command(executable, "-test.run=^TestHookWriterProcess$", "-test.timeout=15s")
		cmd.Env = append(os.Environ(), "MEX_RECORD_WRITER_PEER="+name, "MEX_RECORD_WRITER_HOME="+location.Home, "MEX_RECORD_WRITER_BARRIER="+barrier)
		output := &bytes.Buffer{}
		cmd.Stdout = output
		cmd.Stderr = output
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		peers = append(peers, peer{cmd, output, name})
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
			}
		})
	}
	for _, child := range peers {
		waitFile(t, filepath.Join(barrier, "ready-"+child.name))
	}
	if err := os.WriteFile(filepath.Join(barrier, "start"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	maxNS := int64(0)
	for _, child := range peers {
		if err := child.cmd.Wait(); err != nil {
			t.Fatalf("writer %s: %v\n%s", child.name, err, child.output.String())
		}
		data, err := os.ReadFile(filepath.Join(barrier, "result-"+child.name))
		if err != nil {
			t.Fatal(err)
		}
		var summary writerSummary
		if err := json.Unmarshal(data, &summary); err != nil {
			t.Fatal(err)
		}
		if summary.Calls != 100 || time.Duration(summary.MaxNS) > WriterOperationTimeout {
			t.Fatalf("writer %s: %+v", child.name, summary)
		}
		if summary.MaxNS > maxNS {
			maxNS = summary.MaxNS
		}
	}
	hooks, err = OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	var count int
	if err := hooks.db.QueryRow("SELECT count(*) FROM sessions").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 300 {
		t.Fatalf("lost rows: %d, want 300", count)
	}
	if time.Duration(maxNS) <= time.Duration(ReaderBusyTimeoutMS)*time.Millisecond {
		t.Fatal("fixture did not exercise contention beyond the reader timeout")
	}
	t.Logf("3 Go writer processes, 300 rows, max API call %.3f ms (bound %s)", float64(maxNS)/1e6, WriterOperationTimeout)
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("test barrier did not appear: %s", filepath.Base(path))
}

// A real process per writer; it is never included in a product binary.
func TestHookWriterProcess(t *testing.T) {
	name := os.Getenv("MEX_RECORD_WRITER_PEER")
	if name == "" {
		return
	}
	home := os.Getenv("MEX_RECORD_WRITER_HOME")
	barrier := os.Getenv("MEX_RECORD_WRITER_BARRIER")
	start := time.Now()
	hooks, err := OpenHooks(Location{Home: home, Hooks: filepath.Join(home, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	summary := writerSummary{MaxNS: time.Since(start).Nanoseconds()}
	if time.Duration(summary.MaxNS) > WriterOperationTimeout {
		t.Fatal("open exceeded operation bound")
	}
	if err := os.WriteFile(filepath.Join(barrier, "ready-"+name), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitFile(t, filepath.Join(barrier, "start"))
	if name != "a" {
		waitFile(t, filepath.Join(barrier, "holding"))
	}
	for index := 0; index < 100; index++ {
		held := name == "a" && index%20 == 0
		if held {
			if _, err := hooks.db.Exec("BEGIN IMMEDIATE"); err != nil {
				t.Fatal(err)
			}
			if index == 0 {
				if err := os.WriteFile(filepath.Join(barrier, "holding"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			time.Sleep(40 * time.Millisecond)
		}
		start := time.Now()
		err := hooks.PutSession(Session{SessionID: fmt.Sprintf("%s-%d", name, index), Agent: "test", ProjectID: "fixture", Checkout: "/fixture", StartedAt: "now", LastSeenAt: "now"})
		elapsed := time.Since(start)
		if held {
			if _, commitErr := hooks.db.Exec("COMMIT"); commitErr != nil {
				t.Fatal(commitErr)
			}
		}
		if err != nil {
			t.Fatal(err)
		}
		if elapsed > WriterOperationTimeout {
			t.Fatalf("write exceeded bound: %s", elapsed)
		}
		summary.Calls++
		if elapsed.Nanoseconds() > summary.MaxNS {
			summary.MaxNS = elapsed.Nanoseconds()
		}
		time.Sleep(time.Millisecond)
	}
	data, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(barrier, "result-"+name), data, 0600); err != nil {
		t.Fatal(err)
	}
}
