package entries

import "strings"

// LearnedID identifies older learned entries and their judge rewrites.
func LearnedID(id string) bool {
	return strings.HasPrefix(id, "mx_deep")
}

func (e *Entry) Learned() bool {
	return e.Source.Producer == "learn-deeper" || LearnedID(e.ID)
}
