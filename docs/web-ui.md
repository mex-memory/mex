# Web dashboard

`mex ui` serves a local web dashboard for the same engine the CLI uses. It runs entirely on your machine, reads `.mex/` and `.mex/graph.db` directly, and never contacts the network.

```bash
npx mex-agent ui       # nothing installed, nothing set up — this still works
mex ui                 # http://127.0.0.1:3847, opens your browser
mex dashboard          # alias
mex ui --port 4000     # a specific port (fails if it is taken)
mex ui --no-open       # start the server only
mex ui --root ../api   # inspect a different project
mex ui --host ::1      # bind another loopback interface
```

The command lives in the `mex-agent` package, not in your project, so it is available before a project has any mex state. Nothing about starting the server is gated on a scaffold: a missing `.mex/` is reported as the `empty` status rather than an error, and the dashboard opens on the setup wizard. `mex ui` is therefore a valid alternative to `mex setup` as a first command in a repository.

Without `--port`, a busy 3847 makes the server walk forward to the next free port and print where it landed. With `--port`, a busy port is an error — silently moving defeats the point of naming one.

## What it shows

The UI is a companion panel: a persistent sidebar keeps the shell in place while the main area switches views. It is meant to stay open while you code, not to be an app you live inside.

**Dashboard.** The default landing view. Four glanceable stats (drift, scaffold, graph, open issues) plus a prioritized "what to do next" list. Stat tiles jump to the matching view. Detail that used to sit on this page now lives on Health, Graph, Activity, and Setup.

**No `.mex/` yet.** A welcome screen explaining what mex builds, leading into the setup wizard.

**Setup.** Scaffold coverage per file, grounding coverage, and a way to start or continue the wizard. The wizard is three decisions, each with a default, so the whole flow is completable by pressing Continue: the template set (code repository or agent-memory workspace), which agents work in the project, and whether to build the code graph now. It then runs setup with a live checklist and ends on the population prompt to paste into your agent. Every step reports its own outcome, so a failed scan or an unavailable graph shows exactly what degraded instead of failing the whole run.

### The step after the prompt

Grounding is a contract between two parties. Your agent writes `grounds_to` entries and `mex://` anchors into `.mex/`; mex then fingerprints the code each one points at. Drift detection compares against those fingerprints, so grounding that was authored but never captured is documentation mex silently cannot verify.

`mex setup` in a terminal captures baselines the moment its agent session ends. The browser has no agent session to wait on — you leave, paste the prompt somewhere else, and come back — so the wizard ends with an explicit **capture grounding** action, and the same panel stays on Setup for when you close the tab mid-flow. The dashboard raises it as a recommendation whenever the scaffold references symbols that have no baseline, ranked above drift because capturing changes what the drift report can see.

Capture reports what actually happened rather than a bare success. Zero captured means your agent wrote prose without anchoring it; a skipped reference means it named a symbol the graph does not have, usually a hand-written or hallucinated id. Both are worth knowing.

**Health.** The drift score with its verdict in words, issues grouped by cause rather than as a flat list, and heartbeat staleness.

**Graph.** Code-graph totals and parse health. The graph can be built or rebuilt from here. There is no interactive explorer yet — symbol browsing stays in `mex graph query` and `mex graph scope`.

**Activity.** Recent `mex log` events.

**Settings.** Project identity and a note that this server is local and single-project.

**Broken `.mex/`.** When a scaffold exists but cannot be loaded (a missing `ROUTER.md`, say), the dashboard says what is wrong and offers to repair it by re-running setup, which never overwrites populated files.

Panels load independently, so a slow drift check — it shells out to git per file — never blocks the rest of the page. Switching views does not restart those loads.

## Architecture

The UI is a consumer of the engine, not a second implementation of it. Nothing here re-derives a drift score, parses source, or writes a scaffold; every read and write goes through an existing engine entry point.

| Module | Responsibility |
|---|---|
| `src/ui/index.ts` | The `mex ui` command: start the server, print the banner, open a browser |
| `src/ui/server.ts` | `node:http` server — static assets, JSON API, SSE, loopback enforcement |
| `src/ui/api.ts` | Transport-agnostic router: takes a request record, returns a response record |
| `src/ui/snapshot.ts` | Read-only project state: `empty` / `ready` / `error`, scaffold coverage, identity |
| `src/ui/graph-stats.ts` | Read-only aggregation over `graph.db` |
| `src/ui/grounding.ts` | Read-only grounding coverage: authored references vs captured baselines |
| `src/ui/jobs.ts` | In-memory job registry with steps, a log, and pub/sub for streaming |
| `src/ui/setup-runner.ts` | Setup, graph build, and grounding capture as jobs, delegating every disk write to the engine |
| `src/ui/assets.ts` | Locates the built frontend across source, built, and installed layouts |
| `packages/mex-ui` | The React + Vite frontend |

`src/setup/steps.ts` holds the parts of setup that touch disk — template resolution, project-state detection, scaffold and tool-config copying, population-prompt selection — as plain functions. Both the interactive CLI wizard and the web wizard drive those, so setup logic exists in exactly one place.

### Opening the UI has no side effects

Read endpoints use `findConfig` rather than the CLI's identity-backfilling `loadConfig`, so viewing the dashboard never mints a scaffold identity or rewrites config. `ui` and `dashboard` are also in `SIDE_EFFECT_FREE_COMMANDS` in `src/cli.ts`, which suppresses telemetry and the first-run notice. Writes happen only behind the two POST endpoints, and only when you click something.

### Local by construction

The default bind address is `127.0.0.1`. Non-loopback clients are refused, and the `Host` header is validated so a hostile page cannot reach the API by resolving its own name to loopback (DNS rebinding). Request bodies are capped at 1 MB, and static paths are resolved under the asset directory so a traversal attempt falls through to the SPA shell instead of reading your disk.

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | Version and the root being served |
| GET | `/api/snapshot` | Project status, scaffold coverage, identity, graph file info |
| GET | `/api/setup/plan` | What setup would do: detected state, file list, mex-repo guard |
| GET | `/api/drift` | A real `runDriftCheck` report plus non-fatal warnings |
| GET | `/api/activity?limit=n` | Recent `mex log` events and heartbeat result |
| GET | `/api/graph` | Graph totals, parse health, nodes and edges by kind, languages |
| GET | `/api/grounding` | Authored grounding references vs captured baselines, per file |
| POST | `/api/setup` | Starts a setup job — body `{ mode, tools, buildGraph }` |
| POST | `/api/graph/build` | Starts a graph build job |
| POST | `/api/grounding/capture` | Starts a grounding-capture job (`captureGroundingBaselines`) |
| GET | `/api/jobs` | All jobs from this server's lifetime |
| GET | `/api/jobs/:id` | One job's current state |
| GET | `/api/jobs/:id/stream` | Server-sent events, one frame per state change |

Errors are always `{ error: { code, message, hint? } }`. A missing scaffold is a `409 SCAFFOLD_UNAVAILABLE` rather than a 500, so the frontend can distinguish "not set up yet" from "something broke". Capture refuses the same way with `409 GRAPH_UNAVAILABLE` when there is no graph, since a job that can only report zero baselines is less useful than the reason.

Jobs live in memory for the life of the server process. The stream sends current state immediately on connect, so a reload mid-build renders correctly without a separate fetch, and closes as soon as the job reaches a terminal state. The frontend falls back to polling when `EventSource` is unavailable.

## Development

```bash
npm run build          # CLI, then frontend, then copy assets into dist/ui
npm run build:cli      # CLI only — tsup plus graph assets
npm run build:ui       # frontend only — typecheck plus vite build
npm run dev:ui         # Vite dev server with hot reload
npm test               # includes the ui-* and setup-steps suites
```

For frontend work, run `mex ui --no-open` in one terminal and `npm run dev:ui` in another, then open the Vite URL. The dev server proxies `/api` to port 3847, so the frontend talks to a real engine while hot-reloading.

`mex ui` without a built frontend serves an actionable page telling you to run `npm run build:ui`, rather than failing to start.

Tests cover the snapshot layer, grounding coverage, the API router against real scaffolds on disk, the job registry, the HTTP server including its host and traversal guards, the extracted setup steps, and the frontend's pure interpretation logic (`format.ts`, `health.ts`).

### Testing the wizard

Setup refuses to run inside the mex checkout — it would overwrite the templates it reads from — and every wizard run is one-way, so there is nothing to test against by default. `npm run sandbox` fixes that:

```bash
npm run sandbox                  # recreate a throwaway project and serve the UI against it
npm run sandbox -- --keep        # reuse the existing sandbox (test the dashboard, not the wizard)
npm run sandbox:populate         # stand in for the agent: fill the scaffold and author grounding
```

The sandbox is a small real TypeScript project (an order service with actual call edges) at `.sandbox/orders`, complete with its own `.git` so `findProjectRoot` stops there rather than walking up into this repo. Re-running the script wipes and reseeds it, which makes the wizard re-runnable from zero.

`sandbox:populate` is what makes the second half of the flow testable. The wizard hands you a prompt to paste into a coding agent, which is where prose and grounding come from — so without a live agent session there is nothing to capture. The populate step stands in for one: it fills the scaffold and authors real `grounds_to` entries and `mex://` anchors, taking ids and fingerprints from `mex graph scope --fingerprint` exactly as the population prompt instructs an agent to. It is idempotent, and it only grounds a file whose `grounds_to` is still the empty template.

The full loop is: `npm run sandbox` → run the wizard in the browser → `npm run sandbox:populate` → capture grounding on Setup.

## Limitations

- No graph explorer. Browsing symbols and relationships stays in `mex graph query` and `mex graph scope`.
- Drift is reported, not repaired. Fixing drift needs an agent, so the dashboard points you at `mex sync`.
- Scaffold content is not editable from the browser. Markdown files are edited in your editor, by you or your agent.
- Jobs are not persisted. A server restart during a build loses the progress view, though the build itself already wrote what it finished.
- Single project per server. `--root` chooses it at startup.
