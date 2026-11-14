package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"testing"
	"time"
)

//go:embed testdata/timing-baseline.json
var timingBaselineJSON []byte

type timingBaseline struct {
	P50     float64 `json:"p50_ms"`
	BareP50 float64 `json:"bare_p50_ms"`
}

func strictTimingPassed(s, f stats, budget time.Duration) bool {
	return s.p95 <= budget || s.p95 <= f.p95+overheadMs*time.Millisecond
}

func regressionLimit(platform string, counters bool) (time.Duration, error) {
	var baseline struct {
		Platforms map[string]map[string]timingBaseline `json:"platforms"`
	}
	if err := json.Unmarshal(timingBaselineJSON, &baseline); err != nil {
		return 0, err
	}
	record, ok := baseline.Platforms[platform][strconv.FormatBool(counters)]
	if !ok || record.P50 <= record.BareP50 {
		return 0, fmt.Errorf("missing timing baseline for %s counters=%t", platform, counters)
	}
	// Median overhead avoids macOS's noisy p95 tail. Doubling the recorded
	// overhead (or adding 3 ms, whichever is more) leaves room for runner noise
	// but not for the shim doing twice the work; a 5 ms floor stops tiny Linux
	// overheads from turning process noise into failures.
	overhead := record.P50 - record.BareP50
	limit := math.Max(5, math.Max(2*overhead, overhead+3))
	return time.Duration(math.Round(limit * 1e6)), nil
}

func timingVerdict(mode, platform string, counters bool, s, f stats, budget time.Duration) (string, error) {
	if mode == "report" {
		limit, err := regressionLimit(platform, counters)
		if err != nil {
			return "report mode baseline unavailable", err
		}
		detail := fmt.Sprintf("report mode: p50 overhead=%sms limit=%sms regression=%t", ms(s.p50-f.p50), ms(limit), s.p50-f.p50 > limit)
		if s.p50-f.p50 > limit {
			return detail, fmt.Errorf("clear timing regression: %s", detail)
		}
		return detail, nil
	}
	if mode != "" {
		return "invalid timing mode", fmt.Errorf("unknown MEX_HOOK_TIMING_MODE %q", mode)
	}
	if !strictTimingPassed(s, f, budget) {
		return "strict mode", fmt.Errorf("p95 %sms is over the %sms budget and %sms over a bare process", ms(s.p95), ms(budget), ms(s.p95-f.p95))
	}
	return "strict mode passed", nil
}

func TestTimingPolicy(t *testing.T) {
	duration := func(ms float64) time.Duration { return time.Duration(math.Round(ms * 1e6)) }
	for _, tc := range []struct {
		p95, bare float64
		pass      bool
	}{{17, 3, true}, {17.01, 3, false}, {20, 17, true}, {20.01, 17, false}} {
		_, err := timingVerdict("", "windows", true, stats{p95: duration(tc.p95)}, stats{p95: duration(tc.bare)}, 17*time.Millisecond)
		if (err == nil) != tc.pass {
			t.Fatalf("strict p95=%v bare=%v: %v", tc.p95, tc.bare, err)
		}
	}
	for _, platform := range []string{"linux", "darwin", "windows"} {
		for _, counters := range []bool{false, true} {
			limit, err := regressionLimit(platform, counters)
			if err != nil {
				t.Fatal(err)
			}
			for _, delta := range []time.Duration{0, time.Nanosecond} {
				_, err := timingVerdict("report", platform, counters, stats{p50: limit + time.Millisecond + delta, p95: time.Second}, stats{p50: time.Millisecond}, 17*time.Millisecond)
				if (err != nil) != (delta > 0) {
					t.Fatalf("%s counters=%t delta=%v: %v", platform, counters, delta, err)
				}
			}
		}
	}
	if _, err := regressionLimit("unknown", true); err == nil {
		t.Fatal("missing baseline passed")
	}
	if _, err := timingVerdict("typo", "linux", false, stats{}, stats{}, 17*time.Millisecond); err == nil {
		t.Fatal("unknown mode passed")
	}
}

func TestTimingKnownSamples(t *testing.T) {
	for _, sample := range []struct {
		name, platform             string
		counters                   bool
		p50, p95, bareP50, bareP95 float64
		reportPass, strictPass     bool
	}{
		{"current Windows counters", "windows", true, 15.69, 18.90, 7.38, 9.02, true, false},
		// The slowest of the current counter writer's runs on 13-14 Nov.
		{"current Windows counters, slowest run", "windows", true, 16.21, 18.69, 7.40, 8.12, true, false},
		{"current Windows without counters, slowest run", "windows", false, 10.82, 13.67, 7.40, 9.42, true, true},
		{"current macOS counters, slowest run", "darwin", true, 8.44, 17.71, 3.49, 9.39, true, false},
		// An earlier counter writer that did about three times the work.
		{"earlier, slower Windows counter writer", "windows", true, 32.53, 40.35, 7.96, 10.01, false, false},
		{"macOS p95 tail", "darwin", true, 8.08, 28.02, 4.21, 8.63, true, false},
		{"Windows additional 20ms", "windows", true, 35.69, 38.90, 7.38, 9.02, false, false},
		{"Linux additional 6ms", "linux", true, 8.76, 8.98, 0.82, 0.89, false, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			duration := func(ms float64) time.Duration { return time.Duration(math.Round(ms * 1e6)) }
			s := stats{p50: duration(sample.p50), p95: duration(sample.p95)}
			f := stats{p50: duration(sample.bareP50), p95: duration(sample.bareP95)}
			_, err := timingVerdict("report", sample.platform, sample.counters, s, f, 17*time.Millisecond)
			if (err == nil) != sample.reportPass {
				t.Fatalf("report verdict: %v", err)
			}
			if strictTimingPassed(s, f, 17*time.Millisecond) != sample.strictPass {
				t.Fatal("strict verdict changed")
			}
		})
	}
}
