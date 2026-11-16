package capture

import (
	"testing"
)

type pairCase struct {
	failed, passed string
	exit           int
	between        bool
	want           Verdict
}

// savedPairs are 100 failed-then-passed pairs in the shapes sessions produce.
// Each is labelled by hand: Candidate only where the change could plausibly be
// the fix, Flaky for a plain rerun, Rejected for everything misleading.
var savedPairs = []pairCase{
	// Only flags differ (16).
	{"npm test", "npm test -- --runInBand", 1, false, Candidate},
	{"go test ./...", "go test -count=1 ./...", 1, false, Candidate},
	{"npm install", "npm install --legacy-peer-deps", 1, false, Candidate},
	{"cargo build", "cargo build --locked", 101, false, Candidate},
	{"docker compose up", "docker compose up --build", 1, false, Candidate},
	{"cargo test", "cargo test --all-features", 101, false, Candidate},
	{"go test ./...", "go test -race ./...", 1, false, Candidate},
	{"npm run lint", "npm run lint -- --cache=false", 1, false, Candidate},
	{"npm test", "NODE_ENV=test npm test", 1, false, Candidate},
	{"gradle build", "gradle build --refresh-dependencies", 1, false, Candidate},
	{"mvn package", "mvn -U package", 1, false, Candidate},
	{"python -m pytest", "python -m pytest --import-mode=importlib", 1, false, Candidate},
	{"npx tsc --noEmit", "npx tsc --noEmit --incremental=false", 2, false, Candidate},
	{"vitest run", "vitest run --pool=forks", 1, false, Candidate},
	{"npm run build", "NODE_OPTIONS=--max-old-space-size=4096 npm run build", 1, false, Candidate},
	{"git push", "git push -u origin", 128 - 1, false, Rejected}, // "origin" adds a positional: a different push
	// A prerequisite was added (10).
	{"npm test", "npm ci && npm test", 1, false, Candidate},
	{"pnpm build", "pnpm install && pnpm build", 1, false, Candidate},
	{"go build ./...", "go mod download && go build ./...", 1, false, Candidate},
	{"make", "make clean && make", 2, false, Candidate},
	{"npx prisma migrate dev", "npx prisma generate && npx prisma migrate dev", 1, false, Candidate},
	{"bundle exec rspec", "bundle install && bundle exec rspec", 1, false, Candidate},
	{"yarn build", "yarn install --frozen-lockfile && yarn build", 1, false, Candidate},
	{"dotnet test", "dotnet restore && dotnet test", 1, false, Candidate},
	{"npm install", "rm -rf node_modules && npm install", 1, false, Candidate},
	{"pytest tests", "pip install -e . && pytest tests", 1, false, Candidate},
	// A rerun with nothing changed is flaky (10).
	{"npm test", "npm test", 1, false, Flaky},
	{"go test ./...", "go test ./...", 1, false, Flaky},
	{"cargo test", "cargo test", 101, false, Flaky},
	{"pytest", "pytest", 1, false, Flaky},
	{"make", "make", 2, false, Flaky},
	{"npm run e2e", "npm run e2e", 1, false, Flaky},
	{"./gradlew test", "./gradlew test", 1, false, Flaky},
	{"bundle exec rspec", "bundle exec rspec", 1, false, Flaky},
	{"dotnet test", "dotnet test", 1, false, Flaky},
	{"yarn jest", "yarn jest", 1, false, Flaky},
	// Something else ran or changed in between (8).
	{"npm test", "npm test", 1, true, Rejected},
	{"npm test", "npm test -- --runInBand", 1, true, Rejected},
	{"go build ./...", "go build ./...", 1, true, Rejected},
	{"pytest", "pip install -r requirements.txt && pytest", 1, true, Rejected},
	{"tsc", "tsc", 2, true, Rejected},
	{"cargo build", "cargo build --locked", 101, true, Rejected},
	{"make", "make clean && make", 2, true, Rejected},
	{"npm run build", "npm run build", 1, true, Rejected},
	// A narrower run (15).
	{"npm test", "npm test -- src/a.test.ts", 1, false, Rejected},
	{"pytest", "pytest tests/test_a.py", 1, false, Rejected},
	{"pytest", "pytest -k login", 1, false, Rejected},
	{"jest", "jest -t 'adds numbers'", 1, false, Rejected},
	{"go test ./...", "go test -run TestA ./...", 1, false, Rejected},
	{"go test ./...", "go test ./pkg/a", 1, false, Rejected},
	{"cargo test", "cargo test parser", 101, false, Rejected},
	{"vitest run", "vitest run --changed", 1, false, Rejected},
	{"npx playwright test", "npx playwright test --project=chromium", 1, false, Rejected},
	{"pytest", "pytest --lf", 1, false, Rejected},
	{"npm test", "npm test -- --testPathPattern=auth", 1, false, Rejected},
	{"rspec", "rspec spec/models", 1, false, Rejected},
	{"mocha", "mocha --grep api", 1, false, Rejected},
	{"dotnet test", "dotnet test --filter=Category=Unit", 1, false, Rejected},
	{"pytest", "pytest -x", 1, false, Rejected},
	// Output filters and hidden failures (8).
	{"npm test", "npm test | tail -20", 1, false, Rejected},
	{"npm test", "npm test 2>/dev/null", 1, false, Rejected},
	{"make", "make > build.log", 2, false, Rejected},
	{"npm test", "npm test | grep -v WARN", 1, false, Rejected},
	{"go test ./...", "go test ./... | tee out.txt", 1, false, Rejected},
	{"npm test", "npm test || true", 1, false, Rejected},
	{"npm test", "npm test; echo done", 1, false, Rejected},
	{"make", "make; true", 2, false, Rejected},
	// --help and --version (3).
	{"npm test", "npm test --help", 1, false, Rejected},
	{"terraform plan", "terraform plan -help", 1, false, Rejected},
	{"cargo build", "cargo build --version", 101, false, Rejected},
	// Inline scripts, loops, subshells, substitutions, here-documents (9).
	{"node -e 'require(\"x\")'", "node -e 'require(\"x\")' --trace-warnings", 1, false, Rejected},
	{"python -c 'import a'", "python -c 'import a'", 1, false, Rejected},
	{"npm test", "bash -c 'npm test'", 1, false, Rejected},
	{"tsc", "for f in a b; do tsc $f; done", 2, false, Rejected},
	{"psql", "psql <<EOF", 1, false, Rejected},
	{"npm test", "(cd web && npm test)", 1, false, Rejected},
	{"npm test", "npm test $(cat files.txt)", 1, false, Rejected},
	{"npm test", "npm test `cat files.txt`", 1, false, Rejected},
	{"npm test\nnpm run lint", "npm test", 1, false, Rejected},
	// A check turned off (14).
	{"git commit -m x", "git commit --no-verify -m x", 1, false, Rejected},
	{"npm install", "npm install --force", 1, false, Rejected},
	{"jest", "jest --passWithNoTests", 1, false, Rejected},
	{"eslint .", "eslint . --fix", 1, false, Rejected},
	{"jest", "jest -u", 1, false, Rejected},
	{"npm ci", "npm ci --ignore-scripts", 1, false, Rejected},
	{"tsc", "tsc --skipLibCheck", 2, false, Rejected},
	{"pre-commit run", "SKIP=flake8 pre-commit run", 1, false, Rejected},
	{"npm run lint", "npm run lint -- --max-warnings=1000", 1, false, Rejected},
	{"ruff check .", "ruff check . --exit-zero", 1, false, Rejected},
	{"mypy .", "mypy . --ignore-missing-imports", 1, false, Rejected},
	{"git push", "git push --force", 1, false, Rejected},
	{"yarn install --frozen-lockfile", "yarn install", 1, false, Rejected},
	{"black --check .", "black .", 1, false, Rejected},
	// Different commands, odd prerequisites, kills (7).
	{"npm test", "npm run test:unit", 1, false, Rejected},
	{"npm test", "yarn test", 1, false, Rejected},
	{"npm test", "cd web && npm test", 1, false, Rejected},
	{"curl localhost:3000", "sleep 5 && curl localhost:3000", 7, false, Rejected},
	{"npm test", "npm ci && npm test -- --runInBand", 1, false, Rejected},
	{"npm run dev", "npm run dev", 130, false, Rejected},
	{"npm test", "npm test &", 1, false, Rejected},
}

func TestSavedPairsNothingMisleadingGetsThrough(t *testing.T) {
	if len(savedPairs) != 100 {
		t.Fatalf("the set holds %d pairs, want 100", len(savedPairs))
	}
	counts := map[Verdict]int{}
	for i, c := range savedPairs {
		got, reason := Classify(c.failed, c.passed, c.exit, c.between)
		counts[got]++
		if got != c.want {
			t.Errorf("pair %d %q -> %q: got %s (%s), want %s", i, c.failed, c.passed, got, reason, c.want)
		}
		if c.want != Candidate && got == Candidate {
			t.Errorf("pair %d is misleading but passed the strict rule: %q -> %q", i, c.failed, c.passed)
		}
	}
	t.Logf("verdicts over 100 pairs: %d candidate, %d flaky, %d rejected", counts[Candidate], counts[Flaky], counts[Rejected])
}

func TestClassifyNeverAcceptsAPassingFirstRun(t *testing.T) {
	if v, _ := Classify("npm test", "npm test -- --runInBand", 0, false); v != Rejected {
		t.Fatal(v)
	}
}

func TestClassifyAbstainsFromUnknownAndNonRunningFlags(t *testing.T) {
	for _, c := range []pairCase{
		{"pytest", "pytest --collect-only", 1, false, Rejected},
		{"pytest", "pytest --co", 1, false, Rejected},
		{"pytest", "pytest --deselect=tests/test_security.py", 1, false, Rejected},
		{"npm test", "npm test -- --listTests", 1, false, Rejected},
		{"jest", "jest --listTests", 1, false, Rejected},
		{"go test ./...", "go test -list=. ./...", 1, false, Rejected},
		{"go test ./...", "go test -count=0 ./...", 1, false, Rejected},
		{"pytest", "pytest -ksecurity", 1, false, Rejected},
		{"pytest", "pytest --plugin-selected-tests", 1, false, Rejected},
		{"npm test", "npm test -- --future-selection-flag", 1, false, Rejected},
		{"npm test", "SKIP_TESTS=1 npm test", 1, false, Rejected},
		{"go test ./...", "NODE_OPTIONS=--max-old-space-size=4096 go test ./...", 1, false, Rejected},
		{"pytest", "pytest --runInBand", 1, false, Rejected},
		{"python pytest", "python pytest --import-mode=importlib", 1, false, Rejected},
		{"go test -race ./...", "go test ./...", 1, false, Rejected},
		{"cargo test --all-features", "cargo test", 101, false, Rejected},
		{"custom-check", "custom-check --locked", 1, false, Rejected},
	} {
		t.Run(c.passed, func(t *testing.T) {
			if got, reason := Classify(c.failed, c.passed, c.exit, c.between); got != c.want {
				t.Fatalf("%q -> %q: %s (%s), want %s", c.failed, c.passed, got, reason, c.want)
			}
		})
	}
}
