package tokens

import "testing"

func TestEstimates(t *testing.T) {
	for _, v := range []struct {
		text        string
		code, prose int
	}{
		{"", 0, 0}, {"abcdefghijklmnopqrstuvw", 10, 6}, {"你好 🧭", 5, 3},
	} {
		if Code(v.text) != v.code || Prose(v.text) != v.prose {
			t.Fatalf("estimate %q: %d/%d", v.text, Code(v.text), Prose(v.text))
		}
	}
}
