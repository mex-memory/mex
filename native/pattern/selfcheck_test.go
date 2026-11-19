package pattern

import (
	"strings"
	"testing"
)

func TestSelfCheck(t *testing.T) {
	objected := "import moment from 'moment'\nconst d = moment(x).format('YYYY')\n"
	fixed := "import { format } from 'date-fns'\nconst d = format(x, 'yyyy')\n"
	area := Area{
		"import { format } from 'date-fns'\n",
		"export const x = 1\n",
		"import moment from 'moment' // legacy, being removed\n",
		"console.log('hi')\n",
		"export function f() {}\n",
	}
	cases := []struct {
		name string
		c    Candidate
		area Area
		keep bool
	}{
		{"anti, objected only", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, area, true},
		{"anti, structural", Candidate{Type: "anti", Match: "structural", Pattern: "moment($X)"}, area, true},
		{"anti, not in the objected code", Candidate{Type: "anti", Match: "literal", Pattern: "require('moment')"}, area, false},
		{"anti, also in the fix", Candidate{Type: "anti", Match: "literal", Pattern: "const d ="}, area, false},
		{"anti, too common in the area", Candidate{Type: "anti", Match: "structural", Pattern: "import $X from $Y"}, append(Area{}, area[0], area[2], "import a from 'b'", "x"), false},
		{"anti, area unknown", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, nil, false},
		{"anti, empty area", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, Area{}, true},
		{"rejected", Candidate{Type: "rejected", Match: "literal", Pattern: "moment"}, area[:2], true},
		{"required, fix only", Candidate{Type: "required", Match: "literal", Pattern: "from 'date-fns'"}, nil, true},
		{"required, already there", Candidate{Type: "required", Match: "literal", Pattern: "const d"}, nil, false},
		{"creates", Candidate{Type: "creates", Match: "literal", Pattern: "migrations/*.sql"}, nil, true},
		{"bad structural", Candidate{Type: "anti", Match: "structural", Pattern: "moment("}, area, false},
		{"unknown type", Candidate{Type: "maybe", Match: "literal", Pattern: "x"}, area, false},
	}
	for _, c := range cases {
		c.c.Objected, c.c.Fixed = objected, fixed
		v := SelfCheck(c.c, c.area)
		if v.Keep != c.keep {
			t.Errorf("%s: keep %v (%s)", c.name, v.Keep, v.Reason)
		}
		if v.Reason == "" {
			t.Errorf("%s: no reason", c.name)
		}
	}
	v := SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: "console.log(", Objected: "console.log(x)", Fixed: "log(x)"}, Area{"console.log(1)", "a", "b"})
	if v.Keep || v.Files != 3 || v.Matched != 1 || !strings.Contains(v.Reason, "1 of the area's 3 files") {
		t.Fatalf("share: %+v", v)
	}
}
