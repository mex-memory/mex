package entries

import (
	"github.com/mex-memory/mex/native/delivery/rank"
	"strings"
)

func RankDoc(e *Entry) rank.Doc {
	d := rank.Doc{ID: e.ID, Kind: e.Kind, Title: e.OneLine, Text: e.Text, Scope: e.Scope}
	for _, c := range e.Checks {
		for _, k := range []string{"file", "symbol", "run", "pointer", "pattern"} {
			if s, ok := c.Target[k].(string); ok && s != "" {
				d.Targets = append(d.Targets, s)
				d.Aliases = append(d.Aliases, s)
			}
		}
	}
	for _, w := range e.When {
		if w.Match == "literal" {
			d.Literals = append(d.Literals, w.Pattern)
			d.Aliases = append(d.Aliases, w.Pattern)
		}
	}
	// Quoted commands and identifiers also become exact-match targets.
	for _, text := range []string{e.OneLine, e.Text} {
		parts := strings.Split(text, "`")
		for i := 1; i < len(parts); i += 2 {
			if len(parts[i]) <= 200 {
				d.Targets = append(d.Targets, parts[i])
			}
		}
	}
	return d
}
