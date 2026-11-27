package entries

import (
	"regexp"
	"slices"
	"strings"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/scope"
)

// The file index groups Go and other languages with prose under "other".
// Keep the source suffixes and cutoff in step with src/knowledge/learned-scope.ts.
var sourceSuffix = regexp.MustCompile(`(?i)\.(?:[cm]?[jt]sx?|pyi?|rs|cs|go|java|kts?|scala|rb|php|swift|c|cc|cpp|cxx|h|hh|hpp|m|mm|exs?|erl|hs|ml|fs|dart|lua|r|jl|clj|vue|svelte|zig|sol)$`)

const minSourceFilesForShare = 20

func indexedSourcePaths(paths []string) []string {
	return slices.DeleteFunc(paths, func(path string) bool { return !sourceSuffix.MatchString(path) })
}

func coversMostCode(scopes []string, sourcePaths func() []string) bool {
	hasGlob := false
	fallback := false
	for _, glob := range scopes {
		normalized := scope.Normalize(glob)
		name := normalized
		for strings.HasPrefix(name, "**/") {
			name = name[3:]
		}
		if name == "**" {
			return true
		}
		hasGlob = hasGlob || !scope.Literal(normalized)
		fallback = fallback || !strings.Contains(name, "/") && !scope.Literal(name)
	}
	if !hasGlob {
		return false
	}
	paths := sourcePaths()
	if len(paths) < minSourceFilesForShare {
		return fallback
	}
	patterns := make([]*regexp.Regexp, 0, len(scopes))
	for _, glob := range scopes {
		if pattern, err := scope.CompileGlob(glob); err == nil {
			patterns = append(patterns, pattern)
		}
	}
	needed := (len(paths)*3 + 9) / 10
	hits, misses := 0, 0
	for _, path := range paths {
		if slices.ContainsFunc(patterns, func(pattern *regexp.Regexp) bool { return pattern.MatchString(path) }) {
			hits++
			if hits == needed {
				return true
			}
		} else {
			misses++
			if misses > len(paths)-needed {
				return false
			}
		}
	}
	return false
}

// CheckoutBroadLearned reads one index snapshot at most, when an in-scope
// learned candidate reaches the classifier.
func CheckoutBroadLearned(directory, project, checkout string) func(*Entry) bool {
	return BroadLearned(func() []string {
		idx, err := index.Open(directory, project, checkout)
		if err != nil {
			return nil
		}
		defer idx.Close()
		paths, err := idx.IndexedPaths()
		if err != nil {
			return nil
		}
		return paths
	})
}

// BroadLearned classifies learned entries. Pass nil without a checkout index.
func BroadLearned(indexedPaths func() []string) func(*Entry) bool {
	loaded := false
	var paths []string
	var cache map[string]bool
	return func(e *Entry) bool {
		if !e.Learned() {
			return false
		}
		key := strings.Join(e.Scope, "\n") // entries disallow newlines in scopes
		if broad, ok := cache[key]; ok {
			return broad
		}
		broad := coversMostCode(e.Scope, func() []string {
			if !loaded {
				loaded = true
				if indexedPaths != nil {
					paths = indexedSourcePaths(indexedPaths())
				}
			}
			return paths
		})
		if cache == nil {
			cache = map[string]bool{}
		}
		cache[key] = broad
		return broad
	}
}
