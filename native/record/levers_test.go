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
