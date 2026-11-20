package record

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLeverTransactionsAndPrune(t *testing.T) {
	loc := testLocation(t)
	h, err := openHooks(loc, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, e := openHooks(loc, testBudget)
			if e != nil {
				errs <- e
				return
			}
			defer c.Close()
			errs <- c.UpdateLeverState("a", "s", "", now, false, false, func(data []byte, g *OutlineGuard) ([]byte, error) {
				n, _ := strconv.Atoi(string(data))
				g.Outlines++
				return []byte(strconv.Itoa(n + 1)), nil
			})
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	err = h.UpdateLeverState("a", "s", "", now, false, false, func(data []byte, g *OutlineGuard) ([]byte, error) {
		if string(data) != "16" || g.Outlines != 16 {
			return nil, fmt.Errorf("lost update: %s %+v", data, g)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, nudge := range []bool{false, true} {
		err = h.UpdateLeverState("a", "old", "", now.Add(-8*24*time.Hour), false, nudge, func([]byte, *OutlineGuard) ([]byte, error) { return []byte("old"), nil })
		if err != nil {
			t.Fatal(err)
		}
		err = h.UpdateLeverState("a", "old", "", now, true, nudge, func(data []byte, _ *OutlineGuard) ([]byte, error) {
			if len(data) != 0 {
				return nil, fmt.Errorf("not pruned")
			}
			return nil, nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestLeverStateRollbackAndIsolation(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now()
	for _, key := range [][3]string{{"a", "s", ""}, {"a", "s", "child"}, {"b", "s", ""}} {
		err = h.UpdateLeverState(key[0], key[1], key[2], now, false, false, func([]byte, *OutlineGuard) ([]byte, error) { return []byte(strings.Join(key[:], "/")), nil })
		if err != nil {
			t.Fatal(err)
		}
	}
	err = h.UpdateLeverState("a", "s", "", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) { g.Outlines = 99; return nil, errors.New("rollback") })
	if err == nil {
		t.Fatal("accepted failed callback")
	}
	for _, key := range [][3]string{{"a", "s", ""}, {"a", "s", "child"}, {"b", "s", ""}} {
		data, e := h.LeverState(key[0], key[1], key[2])
		if e != nil || string(data) != strings.Join(key[:], "/") {
			t.Fatal("state collision", string(data), e)
		}
	}
	err = h.UpdateLeverState("a", "s", "", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
		if g.Outlines != 0 {
			t.Fatal("guard survived rollback")
		}
		return []byte(strings.Repeat("x", (4<<20)+1)), nil
	})
	if err == nil {
		t.Fatal("unbounded state")
	}
	data, err := h.LeverState("a", "s", "")
	if err != nil || string(data) != "a/s/" {
		t.Fatal("overlarge update survived")
	}
}

func TestOriginalScanStorageBoundsAndLifecycle(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now()
	for i := 0; i < 8; i++ {
		err = h.UpdateLeverState("a", "s", fmt.Sprint(i), now.Add(-8*24*time.Hour), false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
			if err := g.StoreOriginal("p", 0, strings.Repeat("x", (1<<20)+10)); err != nil {
				return nil, err
			}
			return []byte(`{"context":0}`), nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	err = h.UpdateLeverState("a", "s", "overflow", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) { return nil, g.StoreOriginal("p", 0, "x") })
	if err == nil {
		t.Fatal("session cap ignored across subagents")
	}
	text, err := h.OutlineOriginal("a", "s", "0", "p", 0)
	if err != nil || len(text) != 1<<20 {
		t.Fatal("read bound", len(text), err)
	}
	err = h.UpdateLeverState("a", "fresh", "", now, true, false, func([]byte, *OutlineGuard) ([]byte, error) { return []byte(`{}`), nil })
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := h.db.QueryRow("SELECT count(*) FROM outline_originals").Scan(&count); err != nil || count != 0 {
		t.Fatal("orphaned originals", count, err)
	}
	for _, sub := range []string{"", "child"} {
		err = h.UpdateLeverState("a", "s", sub, now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
			if err := g.StoreOriginal("p", 0, "original"); err != nil {
				return nil, err
			}
			return []byte(`{}`), nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	err = h.UpdateLeverState("a", "s", "", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
		g.ClearOriginals = true
		return []byte(`{"context":1}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow("SELECT count(*) FROM outline_originals").Scan(&count); err != nil || count != 0 {
		t.Fatal("clear retained originals", count, err)
	}
}

func TestOriginalWritesAreOnceAndTransactional(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now()
	for _, text := range []string{"first", "second"} {
		err = h.UpdateLeverState("a", "s", "", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
			if err := g.StoreOriginal("p", 1, text); err != nil {
				return nil, err
			}
			return []byte(`{}`), nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	got, err := h.OutlineOriginal("a", "s", "", "p", 1)
	if err != nil || got != "first" {
		t.Fatal("overwritten", got, err)
	}
	for _, key := range [][3]string{{"b", "s", ""}, {"a", "s", "child"}, {"a", "other", ""}} {
		got, err = h.OutlineOriginal(key[0], key[1], key[2], "p", 1)
		if err != nil || got != "" {
			t.Fatal("leaked across identity", err)
		}
	}
	err = h.UpdateLeverState("a", "s", "", now, false, false, func(_ []byte, g *OutlineGuard) ([]byte, error) {
		if err := g.StoreOriginal("rolled-back", 1, "text"); err != nil {
			return nil, err
		}
		return nil, errors.New("abort")
	})
	if err == nil {
		t.Fatal("accepted aborted callback")
	}
	got, err = h.OutlineOriginal("a", "s", "", "rolled-back", 1)
	if err != nil || got != "" {
		t.Fatal("original survived rollback", err)
	}
}
