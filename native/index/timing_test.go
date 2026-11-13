package index

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record"
)

// TestReadTiming measures what a hook pays for one index read, from nothing:
// find the record, the checkout, open the index, read. It runs on a real
// index when MEX_INDEX_TIMING_CHECKOUT names an indexed checkout (and
// MEX_HOME points at its record), with MEX_INDEX_TIMING_FILES listing files
// to read (comma-separated, relative). The bound only catches a read that
// waits or rebuilds; the measured numbers are logged.
func TestReadTiming(t *testing.T) {
	checkout := os.Getenv("MEX_INDEX_TIMING_CHECKOUT")
	if checkout == "" {
		t.Skip("set MEX_INDEX_TIMING_CHECKOUT to an indexed checkout")
	}
	files := strings.Split(os.Getenv("MEX_INDEX_TIMING_FILES"), ",")
	measure := func(read func(*Reader, string) bool) (time.Duration, time.Duration) {
		var samples []time.Duration
		for i := 0; i < 300; i++ {
			file := files[i%len(files)]
			start := time.Now()
			location, err := record.ResolveLocation(record.LocationOptions{ReadOnly: true, IsNetwork: func(string) (bool, error) { return false, errors.New("skip") }})
			if err != nil {
				t.Fatal(err)
			}
			reader, err := record.OpenRecord(location)
			if err != nil {
				t.Fatal(err)
			}
			root, id, found, err := reader.CheckoutRoot(filepath.Join(checkout, filepath.Dir(file)))
			reader.Close()
			if err != nil || !found {
				t.Fatalf("checkout: %v %v", found, err)
			}
			index, err := Open(location.Directory, id, root)
			if err != nil {
				t.Fatal(err)
			}
			if !read(index, file) {
				t.Fatalf("no answer for %s", file)
			}
			index.Close()
			samples = append(samples, time.Since(start))
		}
		sort.Slice(samples, func(a, b int) bool { return samples[a] < samples[b] })
		return samples[len(samples)/2], samples[len(samples)*95/100]
	}
	outline := func(r *Reader, file string) bool {
		answer, miss := r.Outline(file)
		return answer != nil || miss != nil
	}
	symbols := func(r *Reader, file string) bool {
		_, err := r.SymbolsNamed(strings.TrimSuffix(filepath.Base(file), filepath.Ext(file)))
		return err == nil
	}
	for name, read := range map[string]func(*Reader, string) bool{"outline": outline, "symbols named": symbols} {
		p50, p95 := measure(read)
		t.Logf("%s, whole hook path (record + checkout + index + read): p50 %.2f ms, p95 %.2f ms over 300 reads", name, float64(p50.Microseconds())/1000, float64(p95.Microseconds())/1000)
		if p95 > 250*time.Millisecond {
			t.Errorf("%s p95 %s: a read must never wait or rebuild", name, p95)
		}
	}
	// The index part alone, with the record lookup done once.
	location, _ := record.ResolveLocation(record.LocationOptions{ReadOnly: true, IsNetwork: func(string) (bool, error) { return false, errors.New("skip") }})
	reader, _ := record.OpenRecord(location)
	root, id, _, _ := reader.CheckoutRoot(checkout)
	reader.Close()
	var samples []time.Duration
	for i := 0; i < 300; i++ {
		start := time.Now()
		index, err := Open(location.Directory, id, root)
		if err != nil {
			t.Fatal(err)
		}
		index.Outline(files[i%len(files)])
		index.Close()
		samples = append(samples, time.Since(start))
	}
	sort.Slice(samples, func(a, b int) bool { return samples[a] < samples[b] })
	t.Logf("index open + outline only: p50 %.2f ms, p95 %.2f ms", float64(samples[150].Microseconds())/1000, float64(samples[285].Microseconds())/1000)
}
