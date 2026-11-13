package record

import (
	"context"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

type ProjectIdentity struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	RootPath    string `json:"rootPath"`
	Provisional string `json:"provisional,omitempty"`
}

type GitRunner func(directory string, args ...string) (string, error)

func runGit(directory string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", directory}, args...)...)
	output, err := cmd.Output()
	return strings.TrimSpace(string(output)), err
}

var rootHash = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// ResolveProject uses git (bounded calls) only for identity, never a repo build command.
// Only unregistered folders need this fallback; hooks use Reader.CheckoutProjectID.
func ResolveProject(directory string) (ProjectIdentity, error) {
	return resolveProject(directory, runGit)
}

func resolveProject(directory string, git GitRunner) (ProjectIdentity, error) {
	root, err := realPath(directory)
	if err != nil {
		return ProjectIdentity{}, err
	}
	if top, gitErr := git(root, "rev-parse", "--show-toplevel"); gitErr == nil {
		if resolved, pathErr := realPath(top); pathErr == nil {
			root = resolved
			if shallow, shallowErr := git(root, "rev-parse", "--is-shallow-repository"); shallowErr == nil {
				if shallow == "true" {
					return ProjectIdentity{ID: "f-" + shortHash(root), Kind: "folder", RootPath: root, Provisional: "shallow"}, nil
				}
				if output, rootsErr := git(root, "rev-list", "--max-parents=0", "HEAD"); rootsErr == nil {
					roots := []string{}
					for _, hash := range strings.Fields(output) {
						if rootHash.MatchString(hash) {
							roots = append(roots, hash)
						}
					}
					sort.Strings(roots)
					if len(roots) > 0 {
						return ProjectIdentity{ID: "g-" + shortHash(roots[0]), Kind: "git", RootPath: root}, nil
					}
				} else if ref, refErr := git(root, "symbolic-ref", "--quiet", "HEAD"); refErr == nil && strings.HasPrefix(ref, "refs/heads/") {
					if refs, listErr := git(root, "for-each-ref", "--format=%(refname)", "--", ref); listErr == nil {
						found := false
						for _, candidate := range strings.Fields(refs) {
							if candidate == ref {
								found = true
							}
						}
						if !found {
							return ProjectIdentity{ID: "f-" + shortHash(root), Kind: "folder", RootPath: root, Provisional: "unborn"}, nil
						}
					}
				}
			}
		}
	}
	return ProjectIdentity{ID: "f-" + shortHash(root), Kind: "folder", RootPath: root}, nil
}
