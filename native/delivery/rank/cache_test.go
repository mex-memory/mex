package rank

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestStatisticsCachePreservesScoresWithoutText(t *testing.T) {
	docs := []Doc{
		{ID: "mx_poolaa", Kind: "pitfall", Title: "Keep sharedPool open",
			Text:    "Requests share the connection pool because it survives a request.",
			Targets: []string{"sharedPool"}, Scope: []string{"src/**"}},
		{ID: "mx_builda", Kind: "recipe", Title: "Build the service", Text: "Run the compiler."},
	}
	ix := Build(docs)
	b, err := json.Marshal(ix)
	if err != nil {
		t.Fatal(err)
	}
	var restored Index
	if err = json.Unmarshal(b, &restored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ix.Rank("How does `sharedPool` survive requests?"), restored.Rank("How does `sharedPool` survive requests?")) {
		t.Fatal("cache changed ranking")
	}
	if restored.docs[0].doc.Text != "" || restored.docs[0].doc.Title != "" {
		t.Fatal("cache retained source text")
	}
}
func TestStatisticsCacheRejectsIncompatibleFields(t *testing.T) {
	var ix Index
	if json.Unmarshal([]byte(`{"Version":1,"Mode":"bm25f","Docs":[{}],"FieldAvg":[1,1,1,1,1]}`), &ix) == nil {
		t.Fatal("invalid cache accepted")
	}
}

func TestBinaryStatisticsPreserveRankingAndRejectDamage(t *testing.T) {
	ix := Build([]Doc{
		{ID: "mx_poolaa", Kind: "pitfall", Title: "Keep sharedPool open", Text: "Requests share the connection pool.", Scope: []string{"src/**"}, Targets: []string{"sharedPool"}, Literals: []string{"pool.close()"}},
		{ID: "mx_builda", Kind: "recipe", Title: "Build the service", Text: "Run the compiler."},
	})
	b, err := ix.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var restored Index
	if err := restored.UnmarshalBinary(b); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"How does `sharedPool` survive requests?", "pool.close()", "Build the compiler service", "astronomy"} {
		if !reflect.DeepEqual(ix.Rank(query), restored.Rank(query)) {
			t.Fatalf("cache changed ranking for %q", query)
		}
	}
	if restored.docs[0].doc.Title != "" || restored.docs[0].doc.Text != "" {
		t.Fatal("cache retained source prose")
	}
	for n := 0; n < len(b); n++ {
		if restored.UnmarshalBinary(b[:n]) == nil {
			t.Fatalf("accepted truncated cache at %d", n)
		}
	}
	if restored.UnmarshalBinary(append(b, 1)) == nil {
		t.Fatal("accepted trailing bytes")
	}
}
