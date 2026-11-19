package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

type policyFile struct {
	Version  int
	Scorer   string
	Surfaces map[string]string
}
type policyCache struct {
	files  map[string]policyFile
	states map[string]string
}

func readPolicy(env Environment, p string) policyFile {
	if env.policy != nil && env.policy.files != nil {
		if m, ok := env.policy.files[p]; ok {
			return m
		}
	}
	var m policyFile
	if b, err := readScorerFile(p); err != nil || json.Unmarshal(b, &m) != nil || m.Version != 1 {
		m = policyFile{}
	}
	if env.policy != nil {
		if env.policy.files == nil {
			env.policy.files = map[string]policyFile{}
		}
		env.policy.files[p] = m
	}
	return m
}

func surfaceSetting(env Environment, project, surface string) (value string) {
	key := project + "\n" + surface
	if env.policy != nil {
		if v, ok := env.policy.states[key]; ok {
			return v
		}
		defer func() {
			if env.policy.states == nil {
				env.policy.states = map[string]string{}
			}
			env.policy.states[key] = value
		}()
	}
	if record.SurfaceOff(env.RecordDirectory, project, surface) {
		return "off"
	}
	if env.Surfaces != "" {
		if record.ValidSurfaceMode(env.Surfaces) {
			return env.Surfaces
		}
		var overrides map[string]string
		if json.Unmarshal([]byte(env.Surfaces), &overrides) == nil {
			if v := overrides[surface]; record.ValidSurfaceMode(v) {
				return v
			}
		}
	}
	paths := []string{}
	if project != "" && !strings.ContainsAny(project, "/\\:") && project != "." && project != ".." {
		paths = append(paths, filepath.Join(env.RecordDirectory, "hook-delivery", project+".json"))
	}
	paths = append(paths, filepath.Join(env.Home, "controls.json"))
	for _, p := range paths {
		m := readPolicy(env, p)
		if m.Version == 1 {
			v := m.Surfaces[surface]
			if record.ValidSurfaceMode(v) {
				return v
			}
		}
	}
	return record.SurfaceDefault(surface)
}
func surfaceCommand(s string) string {
	if strings.TrimSpace(s) == "" || len(s) > 8192 {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(s)))
	return hex.EncodeToString(sum[:])
}

func toolKey(tool contract.Tool) string {
	data, _ := json.Marshal(struct {
		Name  contract.ToolName
		Input contract.ToolInput
	}{tool.Name, tool.Input})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func surfaceTargets(plan []planned, vs []toolView, cs []record.DeliveryCandidate) {
	for i := range cs {
		e := plan[i].item.Entry
		t := record.SurfaceTarget{Scopes: append([]string{}, e.Scope...)}
		if len(plan[i].anchorPaths) > 0 {
			cs[i].Target = record.SurfaceTarget{Paths: plan[i].anchorPaths}
			continue
		}
		for _, scope := range e.Scope {
			if !strings.ContainsAny(scope, "*?{[") {
				t.Paths = append(t.Paths, scope)
			}
		}
		for _, check := range e.Checks {
			if file, ok := check.Target["file"].(string); ok && file != "" {
				seen := false
				for _, p := range t.Paths {
					seen = seen || p == file
				}
				if !seen {
					t.Paths = append(t.Paths, file)
				}
			}
		}
		for _, w := range triggers(plan[i].item, "anti") {
			t.Anti = append(t.Anti, w.Pattern)
		}
		for _, cmd := range recipeCommands(e) {
			if k := surfaceCommand(cmd); k != "" {
				t.Commands = append(t.Commands, k)
			}
		}
		if cs[i].Surface == "failure-fix" {
			for _, v := range vs {
				if v.failed || v.unknown {
					if k := surfaceCommand(v.command); k != "" {
						t.Failure = k
						break
					}
				}
			}
		}
		cs[i].Target = t
	}
}

// Count original tools, not derived read views or patch files. Claude Code's
// per-tool success event is followed by a batch, so count only the batch.
func surfaceTools(ev contract.Event, env Environment) []record.SurfaceTool {
	if !momentKind(ev) || ev.Kind == contract.Prompt {
		return nil
	}
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	if len(tools) > 64 {
		tools = tools[:64]
	}
	out := make([]record.SurfaceTool, 0, len(tools))
	for _, tool := range tools {
		one := ev
		one.Batch = nil
		one.Tool = &tool
		observation := record.SurfaceTool{Key: toolKey(tool), Success: ev.Kind != contract.PostToolFailure && tool.Output != nil && tool.Output.OK}
		// A failed command still ran. Only successful-rerun evidence needs a
		// proven success: Claude batches declare success, Codex needs an exit code.
		if tool.Name == contract.ToolShell {
			observation.Command = surfaceCommand(tool.Input.Command)
			observation.Tested = testCommand(tool.Input.Command)
			if ev.Checkout != "" {
				observation.History = historyPaths(tool.Input.Command, ev.Cwd, ev.Checkout)
			}
			if ev.Agent == "codex" {
				observation.Success = observation.Success && tool.Output.ExitCode != nil && *tool.Output.ExitCode == 0
			} else if tool.Output != nil && tool.Output.ExitCode != nil && *tool.Output.ExitCode != 0 {
				observation.Success = false
			}
		}
		for _, v := range views(one, env.Resolve) {
			if v.project == "" || v.checkout == "" {
				continue
			}
			if observation.Scoped == nil {
				observation.Scoped = map[string]record.SurfaceTool{}
			}
			key := v.project + "\n" + v.checkout
			scoped := observation.Scoped[key]
			scoped.Key = observation.Key
			scoped.Success = observation.Success
			scoped.Tested = observation.Tested
			if v.name == contract.ToolShell {
				scoped.Command = surfaceCommand(v.command)
				scoped.History = historyPaths(v.command, ev.Cwd, v.checkout)
			}
			if v.name == contract.ToolRead || isEdit(v) {
				scoped.Paths = append(scoped.Paths, v.rel)
				scoped.Open = scoped.Open || v.name == contract.ToolRead
				if v.name == contract.ToolRead {
					scoped.Reads = append(scoped.Reads, record.SurfaceRead{Path: v.rel, Start: max(1, v.start), End: v.end})
				}
				scoped.Edit = scoped.Edit || isEdit(v)
				scoped.Added += boundedText(v.added, 32768-len(scoped.Added))
			}
			observation.Scoped[key] = scoped
		}
		if main, ok := observation.Scoped[ev.ProjectID+"\n"+ev.Checkout]; ok {
			scoped := observation.Scoped
			observation = main
			observation.Scoped = scoped
		}
		out = append(out, observation)
	}
	return out
}
