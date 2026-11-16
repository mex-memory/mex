package output

import (
	"path"
	"strings"

	"github.com/mex-memory/mex/native/internal/shellparse"
)

// Noisy reports whether a shell command's output may be trimmed: tests,
// builds, installs, linters, `git log`, big searches and `find`. A command
// with any explicit read in it (cat, head, sed, `git diff`, `git show`,
// `mex out` and the like) never is, nor one that asks for raw output.
func Noisy(command string) bool {
	if strings.Contains(command, "MEX_RAW=1") {
		return false
	}
	noisy := false
	for _, segment := range shellparse.Segments(command) {
		words := program(shellparse.Words(segment))
		if len(words) == 0 {
			continue
		}
		if explicitRead(words) {
			return false
		}
		if noisyCommand(words) {
			noisy = true
		}
	}
	return noisy
}

// program drops what runs before the real program: variable assignments and
// runners such as `env`, `time`, `npx` or `uv run`.
func program(words []string) []string {
	for len(words) > 0 {
		w := words[0]
		switch {
		case strings.Contains(w, "=") && !strings.HasPrefix(w, "-") && !strings.HasPrefix(w, "="):
			words = words[1:]
		case w == "env" || w == "time" || w == "nice" || w == "command" || w == "exec" || w == "npx" || w == "bunx" || w == "pnpx" || w == "dotenv" || w == "--":
			words = words[1:]
		case (w == "uv" || w == "poetry" || w == "pipenv" || w == "hatch" || w == "pdm" || w == "rye") && len(words) > 1 && words[1] == "run":
			words = words[2:]
		case (w == "pnpm" || w == "yarn" || w == "bundle") && len(words) > 1 && (words[1] == "exec" || words[1] == "dlx"):
			words = words[2:]
		case w == "npm" && len(words) > 1 && words[1] == "exec":
			words = words[2:]
		default:
			return words
		}
	}
	return words
}

func base(w string) string {
	w = strings.ReplaceAll(w, `\`, "/")
	b := strings.ToLower(path.Base(w))
	for _, ext := range []string{".exe", ".cmd", ".bat", ".ps1"} {
		b = strings.TrimSuffix(b, ext)
	}
	return b
}

var readPrograms = map[string]bool{
	"cat": true, "head": true, "tail": true, "less": true, "more": true, "sed": true, "awk": true, "nl": true,
	"bat": true, "batcat": true, "type": true, "get-content": true, "gc": true, "xxd": true, "od": true, "hexdump": true,
	"strings": true, "jq": true, "yq": true, "diff": true, "cmp": true, "view": true, "vim": true, "vi": true, "nano": true,
	"wc": true, "file": true, "stat": true, "readlink": true,
}

// explicitRead: the person or agent asked for this text on purpose.
func explicitRead(words []string) bool {
	p := base(words[0])
	if readPrograms[p] {
		return true
	}
	sub := ""
	if len(words) > 1 {
		sub = words[1]
	}
	switch p {
	case "git":
		sub = gitSubcommand(words[1:])
		switch sub {
		case "diff", "show", "cat-file", "blame", "format-patch", "range-diff", "stash", "apply", "am":
			return true
		}
	case "mex", "mex-hook":
		return sub == "out" || sub == "run"
	case "python", "python3", "py", "node", "deno", "bun", "ruby", "perl", "php":
		// An inline script reads whatever it prints.
		for _, w := range words[1:] {
			if w == "-c" || w == "-e" || w == "--eval" || w == "-p" || w == "--print" {
				return true
			}
		}
	}
	return false
}

// gitSubcommand skips git's own options (-C dir, -c key=value, --no-pager).
func gitSubcommand(words []string) string {
	for i := 0; i < len(words); i++ {
		w := words[i]
		if w == "-C" || w == "-c" || w == "--git-dir" || w == "--work-tree" {
			i++
			continue
		}
		if strings.HasPrefix(w, "-") {
			continue
		}
		return w
	}
	return ""
}

var noisyPrograms = map[string]bool{
	// test runners
	"vitest": true, "jest": true, "mocha": true, "ava": true, "tap": true, "playwright": true, "cypress": true,
	"pytest": true, "py.test": true, "tox": true, "nox": true, "rspec": true, "phpunit": true, "ctest": true,
	"nextest": true,
	// builds and type checks
	"tsc": true, "tsup": true, "esbuild": true, "webpack": true, "rollup": true, "vite": true, "next": true,
	"make": true, "cmake": true, "ninja": true, "bazel": true, "bazelisk": true, "mvn": true, "mvnw": true,
	"gradle": true, "gradlew": true, "msbuild": true, "turbo": true, "nx": true, "lerna": true,
	"mypy": true, "pyright": true,
	// linters
	"eslint": true, "prettier": true, "biome": true, "ruff": true, "flake8": true, "pylint": true, "black": true,
	"golangci-lint": true, "staticcheck": true, "stylelint": true, "rubocop": true, "shellcheck": true,
	"hadolint": true, "markdownlint": true, "clippy-driver": true,
	// big searches
	"rg": true, "grep": true, "egrep": true, "fgrep": true, "ag": true, "ack": true, "find": true, "fd": true,
	"select-string": true, "sls": true, "get-childitem": true, "tree": true,
	// installs
	"pip": true, "pip3": true, "composer": true,
}

var scriptWords = []string{"test", "build", "lint", "check", "typecheck", "type-check", "tsc", "compile", "e2e", "ci", "verify", "format"}

func noisyCommand(words []string) bool {
	p := base(words[0])
	if noisyPrograms[p] {
		return true
	}
	sub := ""
	if len(words) > 1 {
		sub = strings.ToLower(words[1])
	}
	switch p {
	case "npm", "pnpm", "yarn", "bun", "deno":
		switch sub {
		case "test", "t", "tst", "build", "install", "i", "ci", "add", "update", "upgrade", "outdated", "audit", "lint", "rebuild", "pack", "dedupe", "prune":
			return true
		case "run", "run-script":
			if len(words) > 2 {
				return scriptLike(words[2])
			}
		default:
			// `pnpm test:unit`, `yarn build`: a script name as the subcommand.
			return (p == "pnpm" || p == "yarn" || p == "bun") && scriptLike(sub)
		}
	case "go":
		switch sub {
		case "test", "build", "vet", "install", "generate", "mod", "get":
			return true
		}
	case "cargo":
		switch sub {
		case "test", "build", "check", "clippy", "nextest", "bench", "fetch", "install", "update", "doc", "fmt":
			return true
		}
	case "dotnet":
		switch sub {
		case "test", "build", "restore", "publish", "format":
			return true
		}
	case "python", "python3", "py":
		if sub == "-m" && len(words) > 2 {
			switch base(words[2]) {
			case "pytest", "unittest", "pip", "mypy", "ruff", "pylint", "flake8", "black", "tox", "build":
				return true
			}
		}
	case "uv":
		return sub == "sync" || sub == "pip" || sub == "add" || sub == "lock"
	case "poetry", "pipenv", "pdm":
		return sub == "install" || sub == "update" || sub == "lock" || sub == "add" || sub == "sync"
	case "bundle", "gem":
		return sub == "install" || sub == "update" || sub == "exec"
	case "git":
		switch gitSubcommand(words[1:]) {
		case "log", "reflog", "shortlog", "grep", "ls-files", "rev-list":
			return true
		}
	case "swift":
		return sub == "build" || sub == "test"
	case "mix":
		return sub == "test" || sub == "compile" || sub == "deps.get"
	case "zig":
		return sub == "build" || sub == "test"
	case "terraform":
		return sub == "plan" || sub == "init" || sub == "validate"
	case "docker", "podman":
		return sub == "build" || (sub == "compose" && len(words) > 2 && (words[2] == "build" || words[2] == "pull"))
	}
	return false
}

func scriptLike(name string) bool {
	name = strings.ToLower(name)
	for _, w := range scriptWords {
		if name == w || strings.HasPrefix(name, w+":") || strings.HasPrefix(name, w+"-") || strings.HasSuffix(name, ":"+w) || strings.HasSuffix(name, "-"+w) {
			return true
		}
	}
	return false
}
