// Package captureprofile declares the learning inputs the adapter can attest to.
package captureprofile

import (
	_ "embed"
	"encoding/json"
)

//go:embed profiles.json
var data []byte

type Profile struct {
	Typed      string `json:"typed"`
	Transcript string `json:"transcript"`
	Cache      bool   `json:"cache"`
	Outside    string `json:"outside"`
	Choices    bool   `json:"choices"`
	Memory     bool   `json:"memory"`
	Finish     string `json:"finish"`
}

var profiles = func() map[string]Profile {
	var out map[string]Profile
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err) // This is the embedded build-time manifest.
	}
	return out
}()

func For(agent string) Profile { return profiles[agent] }

func (p Profile) CapturesTyped() bool { return p.Typed == "hook" || p.Typed == "plugin" }
