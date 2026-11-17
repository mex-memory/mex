package delivery

import (
	"strings"

	"github.com/mex-memory/mex/native/delivery/rank"
)

// directiveTrial is an offline pair-study predicate, deliberately separate
// from production admission. Common key terms can describe different objects.
func directiveTrial(a, b shaped) bool {
	if !overlapping(a, b) || !compatiblePolicy(a.item.Entry.Kind, b.item.Entry.Kind) {
		return false
	}
	type directive struct {
		positive bool
		key      string
		prefer   string
		over     string
	}
	parse := func(text string) []directive {
		var out []directive
		text = strings.ToLower(boundedText(text, 4096))
		for _, sentence := range strings.Split(strings.ReplaceAll(text, "\n", ". "), ". ") {
			words := strings.Fields(sentence)
			for i, word := range words {
				word = strings.Trim(word, "`,:;()")
				if word == "prefer" {
					for j := i + 2; j < len(words)-1; j++ {
						if words[j] == "over" {
							out = append(out, directive{
								prefer: strings.Join(rank.Tokens(strings.Join(words[i+1:j], " ")), " "),
								over:   strings.Join(rank.Tokens(strings.Join(words[j+1:], " ")), " "),
							})
							break
						}
					}
					continue
				}
				positive := word == "use" || word == "must" || word == "always"
				negative := word == "avoid" || word == "never"
				if !positive && !negative {
					continue
				}
				keys := rank.Tokens(strings.Join(words[i+1:], " "))
				if len(keys) > 0 {
					out = append(out, directive{positive: positive, key: keys[0]})
				}
			}
		}
		return out
	}
	for _, x := range parse(a.item.Entry.OneLine + ". " + a.item.Entry.Text) {
		for _, y := range parse(b.item.Entry.OneLine + ". " + b.item.Entry.Text) {
			if x.key != "" && x.key == y.key && x.positive != y.positive {
				return true
			}
			if x.prefer != "" && x.over != "" && x.prefer == y.over && x.over == y.prefer {
				return true
			}
		}
	}
	return false
}

func compatiblePolicy(a, b string) bool {
	if a == b {
		return true
	}
	policy := func(kind string) bool { return kind == "rule" || kind == "decision" || kind == "pitfall" }
	return policy(a) && policy(b)
}
