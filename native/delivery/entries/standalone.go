package entries

// ItemFromFile builds a matchable item from one entry file's bytes, with its
// scopes compiled, for checks that run outside a snapshot: the "would have
// fired" replay at the end of a learning run. It does not filter by status,
// because that replay also shows rules that still wait for a person's tick.
func ItemFromFile(data []byte, level string) (*Item, error) {
	e, err := Parse(data)
	if err != nil {
		return nil, err
	}
	it := &Item{Entry: e, Level: level}
	for _, scope := range e.Scope {
		sc, err := newScope(scope)
		if err != nil {
			return nil, err
		}
		it.Scopes = append(it.Scopes, sc)
	}
	it.Generated = generatedRE().MatchString(e.OneLine + " " + e.Text)
	return it, nil
}
