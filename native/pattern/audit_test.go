package pattern

import "testing"

func TestReviewedCodeContrast(t *testing.T) {
	for _, tc := range []struct {
		name, typ, pattern, before, after, anchor string
		keep                                      bool
	}{
		{"line comment", "anti", "legacyAdapter(", "// legacyAdapter(x)", "// stableAdapter(x)", "", false},
		{"block comment", "anti", "legacyAdapter(", "/* legacyAdapter(x) */", "stableAdapter(x)", "", false},
		{"hash comment", "anti", "legacyAdapter(", "x = 1 # legacyAdapter(x)", "x = 1", "", false},
		{"string content", "anti", "legacyAdapter(", "const s = \"legacyAdapter(x)\"", "const s = \"stableAdapter(x)\"", "", false},
		{"standalone string", "anti", "\"legacyAdapter(x)\"", "const s = \"legacyAdapter(x)\"", "const s = \"stableAdapter(x)\"", "", false},
		{"callee substring", "anti", "legacyAdapter(", "notlegacyAdapter(x)", "stableAdapter(x)", "", false},
		{"dependency string token", "rejected", "\"old-adapter\"", "{\"old-adapter\": \"1\"}", "{\"new-adapter\": \"1\"}", "", true},
		{"short scoped call", "anti", "db.q(", "db.q(x);", "db.safeQuery(x);", "", true},
		{"operator token", "anti", " <= ", "if (left <= right) next();", "if (left < right) next();", "", true},
		{"local call", "anti", "unsafeLocal(", "const unsafeLocal = makeWrapper();\nunsafeLocal(x);", "const unsafeLocal = makeWrapper();\nnewWrapper(x);", "unsafeLocal(x);", true},
		{"unchanged adjacent anchor", "anti", "legacyAdapter(", "const state = readContext();\nlegacyAdapter(x);", "const state = readContext();\nstableAdapter(x);", "const state = readContext();", true},
		{"changed anchor and unrelated neighbor", "anti", "legacyAdapter(", "reviewedAdapter(x);\nlegacyAdapter(x);", "reviewedAdapter(y);\nstableAdapter(x);", "reviewedAdapter(x);", false},
		{"existing fixed form", "required", "stableAdapter(", "stableAdapter(x);\nlegacyAdapter(y);", "stableAdapter(x);\nstableAdapter(y);", "legacyAdapter(y);", true},
		{"CRLF evidence", "anti", "legacyAdapter(x);\nlegacyAdapter(y);", "legacyAdapter(x);\r\nlegacyAdapter(y);", "stableAdapter(x);\r\nstableAdapter(y);", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := SelfCheck(Candidate{Type: tc.typ, Match: "literal", Pattern: tc.pattern, Objected: tc.before, Fixed: tc.after, Anchor: tc.anchor}, Area{})
			if v.Keep != tc.keep {
				t.Fatalf("keep %t, want %t: %s", v.Keep, tc.keep, v.Reason)
			}
		})
	}
}
