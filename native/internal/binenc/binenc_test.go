package binenc

import "testing"

func TestRoundTripAndTruncation(t *testing.T) {
	var w Writer
	w.Uint(7)
	w.Int(-42)
	w.Bool(true)
	w.String("héllo")
	w.Strings([]string{"a", "", "c"})
	w.Set(map[string]bool{"y": true, "x": true, "z": false})
	b := w.Bytes()
	r := NewReader(b)
	if r.Uint() != 7 || r.Int() != -42 || !r.Bool() || r.String() != "héllo" {
		t.Fatal("scalar mismatch")
	}
	if s := r.Strings(8); len(s) != 3 || s[2] != "c" {
		t.Fatal(s)
	}
	if set := r.Set(8); len(set) != 2 || !set["x"] || !set["y"] {
		t.Fatal(set)
	}
	if err := r.Done(); err != nil {
		t.Fatal(err)
	}
	for cut := 0; cut < len(b); cut++ {
		r := NewReader(b[:cut])
		r.Uint()
		r.Int()
		r.Bool()
		_ = r.String()
		r.Strings(8)
		r.Set(8)
		if r.Done() == nil {
			t.Fatalf("truncation at %d accepted", cut)
		}
	}
	r = NewReader(append([]byte{}, b...))
	r.Uint()
	r.Int()
	r.Bool()
	_ = r.String()
	if r.Strings(2) != nil || r.Err() == nil {
		t.Fatal("list over its bound accepted")
	}
}
