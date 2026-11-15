package check

import (
	"testing"
)

func TestDependencyMembershipPinsNameNotArrayOrVersion(t *testing.T) {
	root := t.TempDir()
	write(t, root, "pyproject.toml", "[project]\ndependencies = ['colorama>=0.4', 'click>=8']\n")
	c := record(t, root, "key", Complete, map[string]any{"file": "pyproject.toml", "pointer": "/project/dependencies", "member": "colorama"})
	if c.Saw["value"] != true {
		t.Fatalf("not a presence observation: %+v", c)
	}
	for _, contents := range []string{
		"[project]\ndependencies = ['click>=9', 'colorama>=0.4', 'rich']\n",
		"[project]\ndependencies = ['Colorama[colors]>=0.5; sys_platform == \"win32\"']\n",
		"[project]\ndependencies = ['colorama @ https://example.test/colorama.whl']\n",
	} {
		write(t, root, "pyproject.toml", contents)
		if got := verdict(t, root, c); got.Verdict != Held || len(got.Checks[0].FilesChanged) != 1 {
			t.Fatalf("unrelated change broke membership: %+v", got)
		}
	}
	for _, contents := range []string{"[project]\ndependencies = ['click>=9']\n", "[project]\nname = 'demo'\n", "[project]\ndependencies = ['colorama-tools']\n"} {
		write(t, root, "pyproject.toml", contents)
		if got := verdict(t, root, c); got.Verdict != Broken || got.Checks[0].Now != false {
			t.Fatalf("missing member: %+v", got)
		}
	}
	c.Role = Supporting
	if got := verdict(t, root, c); got.Verdict != Changed {
		t.Fatalf("supporting membership: %+v", got)
	}
}

func TestDependencyMembershipContainersAndUnknownData(t *testing.T) {
	for _, tc := range []struct{ file, content, pointer, member string }{
		{"Cargo.toml", "[dependencies]\nserde = { version = '1', features = ['derive'] }\n", "/dependencies", "serde"},
		{"package.json", `{"dependencies":{"@scope/pkg":"1"}}`, "/dependencies", "@scope/pkg"},
		{"deps.yaml", "dependencies:\n  tool: 1\n", "/dependencies", "tool"},
		{"pyproject.toml", "[project.optional-dependencies]\ncli = ['Friendly._Bard>=1']\n", "/project/optional-dependencies/cli", "friendly-bard"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, tc.file, tc.content)
			c := record(t, root, "key", Complete, map[string]any{"file": tc.file, "pointer": tc.pointer, "member": tc.member})
			if got := verdict(t, root, c); got.Verdict != Held {
				t.Fatal(got)
			}
		})
	}
	root := t.TempDir()
	write(t, root, "deps.json", `{"deps":["colorama"]}`)
	c := record(t, root, "key", Complete, map[string]any{"file": "deps.json", "pointer": "/deps", "member": "colorama"})
	for _, contents := range []string{`{"deps":[42]}`, `{"deps":"colorama"}`, `{"deps":["colorama garbage"]}`, `{"deps":["colorama>="]}`, `{"deps":["colorama[broken"]}`, `{"deps":["colorama;"]}`, `not-json`} {
		write(t, root, "deps.json", contents)
		if got := verdict(t, root, c); got.Verdict == Broken || got.Verdict == Held || got.Checks[0].Status != Floor {
			t.Fatalf("not withheld: %s %+v", contents, got)
		}
		if _, err := evaluator(t, root).Record("key", Complete, c.Target); err == nil {
			t.Fatalf("recorded uncertain member: %s", contents)
		}
	}
	write(t, root, "deps.json", `{"deps":["click"]}`)
	if _, err := evaluator(t, root).Record("key", Complete, c.Target); err == nil {
		t.Fatal("recorded an absent dependency")
	}
}
