// A stdin/stdout peer used by the cross-runtime parity contract.
package main

import (
	"encoding/json"
	"github.com/mex-memory/mex/native/internal/tokens"
	"os"
)

func main() {
	var texts []string
	if json.NewDecoder(os.Stdin).Decode(&texts) != nil {
		os.Exit(1)
	}
	out := make([][2]int, len(texts))
	for i, text := range texts {
		out[i] = [2]int{tokens.Code(text), tokens.Prose(text)}
	}
	if json.NewEncoder(os.Stdout).Encode(out) != nil {
		os.Exit(1)
	}
}
