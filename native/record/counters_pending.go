package record

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A hook gives its counter write 10 ms so it never slows the agent. On a
// slow or busy disk the write misses that window. Instead of losing the
// counts, the hook appends them to a small file beside hooks.db, and the next
// write that gets through adds them in. The file holds only counter names
// and numbers, never a path, payload or session.

// PendingCountersName is the file of counts that missed their write.
const PendingCountersName = "counters-pending"

// maxPendingBytes bounds the file: past it, missed counts are dropped as
// before, so a disk that never recovers can't grow it without limit.
const maxPendingBytes = 64 << 10

// counterWriteTimeout is the hook's budget for one counter write.
const counterWriteTimeout = 10 * time.Millisecond

// RecordHookUsageOrDefer adds one hook call to the counters, together with
// any counts earlier calls couldn't write. When this write misses its
// deadline too, everything it carried goes back to the pending file.
func RecordHookUsageOrDefer(location Location, day, agent string, sessionStart, failed bool, elapsedMS int64) error {
	names, err := usageNames(day, agent, sessionStart, failed, elapsedMS)
	if err != nil {
		return err
	}
	counts := map[counterKey]int{}
	for _, name := range names {
		counts[counterKey{day, name}]++
	}
	for key, n := range claimPendingCounts(location) {
		counts[key] += n
	}
	hooks, err := OpenHookCounters(location)
	if err == nil {
		err = hooks.addCounts(counts, counterWriteTimeout)
		_ = hooks.Close()
	}
	if err != nil {
		deferCounts(location, counts)
	}
	return err
}

func pendingCountersPath(location Location) string {
	return filepath.Join(location.Directory, PendingCountersName)
}

// deferCounts appends counts to the pending file in one write. It never
// creates the record directory, and skips a file that isn't a plain file or
// is already full.
func deferCounts(location Location, counts map[counterKey]int) {
	path := pendingCountersPath(location)
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Size() >= maxPendingBytes) {
		return
	}
	var b bytes.Buffer
	for key, n := range counts {
		if n > 0 && validCounter(key) {
			b.WriteString(key.day + "\t" + key.name + "\t" + strconv.Itoa(n) + "\n")
		}
	}
	if b.Len() == 0 {
		return
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	_, _ = file.Write(b.Bytes())
	_ = file.Close()
}

// claimPendingCounts takes the pending file for this call: it renames it
// first, so two hooks never add the same counts, then reads and removes it.
// If the process dies before its write lands, those counts are lost, never
// counted twice.
func claimPendingCounts(location Location) map[counterKey]int {
	path := pendingCountersPath(location)
	claim := path + "." + strconv.Itoa(os.Getpid()) + ".claim"
	if os.Rename(path, claim) != nil {
		return nil
	}
	defer os.Remove(claim)
	info, err := os.Lstat(claim)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	file, err := os.Open(claim)
	if err != nil {
		return nil
	}
	defer file.Close()
	return parsePendingCounts(io.LimitReader(file, maxPendingBytes+4096))
}

// parsePendingCounts reads "day<TAB>name<TAB>n" lines. Anything that isn't a
// counter a hook writes is ignored.
func parsePendingCounts(r io.Reader) map[counterKey]int {
	counts := map[counterKey]int{}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		parts := strings.Split(scanner.Text(), "\t")
		if len(parts) != 3 {
			continue
		}
		key := counterKey{parts[0], parts[1]}
		n, err := strconv.Atoi(parts[2])
		if err != nil || n < 1 || n > 1_000_000 || !validCounter(key) {
			continue
		}
		counts[key] += n
	}
	return counts
}

// validCounter accepts only the rows usageNames produces.
func validCounter(key counterKey) bool {
	if _, err := time.Parse("2006-01-02", key.day); err != nil {
		return false
	}
	rest, ok := strings.CutPrefix(key.name, "agent:")
	if !ok {
		return false
	}
	agent, name, ok := strings.Cut(rest, ":")
	if !ok || !telemetryAgent(agent) {
		return false
	}
	switch name {
	case "hook.calls", "sessions", "hook.errors", "hook.ms.0", "hook.ms.1", "hook.ms.2", "hook.ms.3", "hook.ms.4", "hook.ms.5":
		return true
	}
	return false
}
