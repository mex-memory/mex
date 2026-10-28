# novu × Codex evaluation: runbook

**For:** Daksh. **From:** Yashasvi. **Date:** 2026-10-28.
**Machine:** your Mac (16 GB RAM, about 30 GB free disk), Codex Pro.

This runbook takes you from a clean machine to a finished evaluation, start to end. Read it once fully before you start. Every command is meant to be copied as written. Wherever a step says **record**, write the value into your run notes (section 12), because we need it for the write-up.

If anything here doesn't match what you see, stop and message Yashasvi with the exact output. Don't improvise a fix. A wrong fix can silently invalidate the comparison.

---

## 1. What we're measuring and why

MEX gives a coding agent project knowledge through **hooks**. At the moment you type a prompt, and after the agent searches, reads or edits code, MEX injects a short note:
- the curated fact or convention that applies;
- or a bounded graph note (where a symbol is defined, its callers).

The question is: **on complex, real tasks in a big codebase, does an agent with MEX hooks use clearly fewer tokens than the same agent with only the repository, while staying as correct?** The target is at least 40% fewer tokens.

- **Agent:** Codex CLI, model `gpt-6.1-sol`, with one fixed reasoning effort for everything (section 9 decides which one).
- **Repository:** novu (about 870k lines, a pnpm monorepo).
- **Tasks:** 13 real novu pull requests, merged between Aug 20 and Oct 19 2026. Each task starts at the commit before the fix and is graded by that PR's own hidden tests, which the agent never sees.
- **Arms** (each task runs once in every arm):

| Arm | What the agent gets |
|---|---|
| `files` | The plain repository at the task's base commit. No MEX at all. |
| `mex-r2w` | Same checkout, plus the MEX knowledge scaffold, prebuilt indexes and MEX hooks. Prompt matching is word-based ("lexical"). |
| `mex-r3` | Same as R2w, but prompt matching also uses a small local embedding model ("semantic"). |

### The no-leak rule
The knowledge MEX gives the agent must never contain the fix it is asked to make. So the knowledge is written **before** the tasks:
- **T0 = `5f9f2d7f23`** (Aug 20). `mex setup` runs here. Its knowledge serves the 5 August tasks.
- **T1 = `6fc9d02ea0`** (Sep 21). The T0 knowledge is brought up to date with `mex sync`. Its knowledge serves the 8 Sep–Oct tasks.

Every workspace (setup, sync and each session) is a repository whose history **ends** at its base commit. Later commits, including the fixes, are physically absent, so no arm can read them with `git log`. The tools in this runbook create and verify that for you.

### Fairness
- Same model, same effort, same prompt, same checkout and same Codex settings in all arms.
- Each session runs in a fresh, isolated Codex profile: only your login is copied in, with memories, plugins, apps, browser, subagents, goals and skill search switched off.
- The only difference between arms is MEX.

---

## 2. Order of work and time

| # | Step | Paid? | Rough time |
|---|---|---|---|
| 3 | Prepare the machine | no | 30–60 min (mostly downloads) |
| 4 | Build the frozen MEX CLI | no | 10 min |
| 5 | Get the harness | no | 5 min |
| 6 | Clone and install novu | no | 20–40 min |
| 7 | **Setup at T0**: real full flow; the graph builds while up to 3 setup agents run | Codex | 1–2 h |
| 8 | **Sync at T1** | Codex | 30–60 min |
| 9 | Check, then **pilot**: 2 tasks × 3 arms × 2 efforts = 12 sessions | Codex | 3–6 h |
| 10 | **Full run**: 13 tasks × 3 arms = 39 sessions | Codex | 15–30 h, unattended |
| 10.1 | Price the run at API list rates | no | 5 min |
| 11 | Send results | no | 10 min |

Steps 7 to 10 can each be interrupted and resumed. Nothing finished is redone.

---

## 3. Prepare the machine

### 3.1 Free RAM and keep the Mac awake
- Quit everything you don't need during steps 7–10: browsers with many tabs, IDEs, Docker, Slack, music, and so on. The graph build on novu peaks at about 4–5 GB, plus the Codex processes and novu's tests. Aim for **at least 9 GB free** when a step starts. The harness waits by itself when free RAM is under 4 GB, but setup and sync (which you run by hand) don't.
- Plug in power. Prefix every long command with `caffeinate -dimsu` (shown below), so the Mac doesn't sleep.

### 3.2 Tools and versions
All of these must match. If a version differs, install the listed one.

| Tool | Version | Check | Install |
|---|---|---|---|
| Node.js | **22.23.x** (novu needs `>=22 <23`; MEX supports 22) | `node --version` | `nvm install 22.23.2 && nvm use 22.23.2` (or `fnm`, or the nodejs.org pkg) |
| pnpm | **11.28.2** (through corepack) | `pnpm --version` | `corepack enable && corepack prepare pnpm@11.28.2 --activate` |
| git | 2.40 or newer | `git --version` | Xcode Command Line Tools, or `brew install git` |
| Codex CLI | **0.163.0** (the version everything was verified with) | `codex --version` | `npm install -g @openai/codex@0.163.0` |
| ripgrep (optional) | any | `rg --version` | `brew install ripgrep`. Codex likes `rg`; installing it is fine because it's the same for every arm. |

Then:
```sh
codex login            # sign in with the Pro account, if you haven't already
codex features list | grep -E "^(hooks|memories) "   # expect: hooks ... true, memories ... false
```
**Record** the output of `node --version`, `pnpm --version`, `codex --version`, `sw_vers -productVersion` and `sysctl -n hw.memsize`.

Make sure no other `mex` is installed globally, because it would be an old version:
```sh
which -a mex mex-hook || echo "none (good)"
```
If something is listed, run `npm uninstall -g mex-agent`. If it's still listed after that, tell Yashasvi.

### 3.3 Codex settings for setup and sync
Setup and sync launch Codex with **your normal profile** (`~/.codex`). The harness sessions later use isolated profiles and don't read it. So that the knowledge is written with a fixed, known configuration, put these lines at the top of `~/.codex/config.toml`, creating the file if needed:
```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
```
Also make sure `[features]` in that file does **not** turn `memories` on. Leave the rest of your config as it is.

Setup and sync always use `high`, whichever effort the pilot later picks for sessions. That's intentional: knowledge authoring is fixed, and only the session effort is compared.

### 3.4 Folder layout
Everything lives under one folder. Create it:
```sh
mkdir -p ~/mex-eval && cd ~/mex-eval
df -h ~ | tail -1          # record free disk
```
```
~/mex-eval/
  mex/          MEX source, branch feat/context-hooks
  harness/      harness checkout, branch eval/codex-harness
  cli/          the frozen MEX CLI used by every step
  novu/         the novu clone (the "subject"), with its node_modules
  ws-t0/        setup workspace (T0)
  ws-t1/        sync workspace (T1)
  seeds/        the two graph files the runs start from
  notes.md      your run notes (section 12)
  results-*/    run outputs
```

### 3.5 Disk budget (expected)

| Item | Size |
|---|---|
| MEX source + its node_modules, harness checkout | ~2 GB |
| Frozen CLI + semantic model | ~0.3 GB |
| novu clone (full history) | ~1 GB |
| novu node_modules (pnpm) | ~3–6 GB (record the real number) |
| ws-t0 and ws-t1 (each: history to its base, checkout, graph, Wiki) | ~2 GB each |
| seeds | ~2 GB |
| A running pipeline (1 base at a time: workspaces, 1 graph cache, 1 chain graph, temp) | ~5–7 GB peak |
| Results (rows, transcripts, logs) | < 1 GB |
| **Total peak** | **~18–22 GB** |

The pipeline deletes each base's workspaces and graphs once that base is done, so it doesn't grow over the run. If free disk falls under 5 GB, it waits instead of failing.

---

## 4. Build the frozen MEX CLI

```sh
cd ~/mex-eval
git clone https://github.com/mex-memory/mex.git mex
cd mex
git checkout feat/context-hooks
git log --oneline -1            # record the commit; it should be f21a6ef or a later one Yashasvi names
npm ci
npm run build
npm pack --pack-destination ~/mex-eval
cd ~/mex-eval
shasum -a 256 mex-agent-*.tgz   # record
mkdir -p cli && cd cli && npm init -y >/dev/null && npm install --no-audit --no-fund ../mex-agent-*.tgz
```

Use this CLI for everything. In **every terminal** you use for steps 7–10, run first:
```sh
export PATH="$HOME/mex-eval/cli/node_modules/.bin:$PATH"
export MEX_TELEMETRY_DISABLED=1
which mex          # must print ~/mex-eval/cli/node_modules/.bin/mex
mex --version      # 0.8.4
mex hooks install --help | grep codex      # must mention: claude (default) or codex
```

Install the semantic extra (the local embedding model the `mex-r3` arm uses). It's a one-time, machine-level install:
```sh
mex context semantic install
mex context semantic status      # must say installed; record the output
```

Never rebuild or update `~/mex-eval/cli` during a run. The harness records its hash and refuses to continue if it changes.

---

## 5. Get the harness

```sh
cd ~/mex-eval/mex
git fetch origin
git worktree add ../harness origin/eval/codex-harness
cd ../harness
git log --oneline -1        # record (6842999 or later)
npm ci
```

You run the harness from `~/mex-eval/harness`. It only needs `npm ci`, not a build.

---

## 6. Clone and install novu (the subject)

The subject must keep its **full** history (every task's base and fix commits). The harness builds the clipped workspaces from it.
```sh
cd ~/mex-eval
git clone https://github.com/novuhq/novu.git novu
cd novu
git checkout --detach 8de73e7553d6bcf03b4ce1513e1627ee8f316459
corepack enable && pnpm --version          # 11.28.2
pnpm install --frozen-lockfile             # record time; if it asks to approve build scripts, approve them
du -sh node_modules                        # record
```

Check that every task commit is present. This prints `13 tasks OK`:
```sh
cd ~/mex-eval/harness
node -e '
const s=require("./evaluate/arm/suites/novu-codex.json");const {execFileSync}=require("child_process");
let bad=0;for(const t of s.tasks)for(const c of [t.base,t.mergeCommit,t.hiddenTests&&t.hiddenTests.fromCommit].filter(Boolean)){
 try{execFileSync("git",["-C",process.env.HOME+"/mex-eval/novu","cat-file","-e",c+"^{commit}"])}catch{bad++;console.log("missing",t.id,c)}}
console.log(bad?bad+" missing":s.tasks.length+" tasks OK")'
```

**Never** run `git pull`, `git checkout` or `pnpm install` in `~/mex-eval/novu` again after this step. Its `node_modules` is shared by every workspace.

---

## 7. Setup at T0: the real full flow

This is also a test of the new setup itself: up to 3 setup agents run in parallel while the code graph builds. We want to know whether a 16 GB machine handles it.

### 7.1 Create the T0 workspace
```sh
cd ~/mex-eval/harness
node evaluate/arm/make-workspace.mjs --subject ~/mex-eval/novu --base 5f9f2d7f2360462642a58ecceb1c0051bd5af80f \
  --deps ~/mex-eval/novu/node_modules --suite evaluate/arm/suites/novu-codex.json --out ~/mex-eval/ws-t0
```
It prints a JSON summary. Check that `forbiddenAbsent` lists the fix commits and that the last line has no error. **Record** `history.commits`.

### 7.2 Start the resource watcher
In a **second terminal**:
```sh
cd ~/mex-eval/harness
node evaluate/arm/watch-resources.mjs --out ~/mex-eval/setup-t0-resources.csv --path ~/mex-eval --match mex,codex,node --interval 5
```
Leave it running until setup ends, then press Ctrl+C. It prints the peak memory and the lowest free RAM and disk. **Record** that line.

### 7.3 Run setup
In the **first terminal** (with the PATH from section 4):
```sh
cd ~/mex-eval/ws-t0
date                          # record the start time
caffeinate -dimsu mex setup --tool codex --no-open
```
What you should see:
1. A setup screen (HUD) with a workflow list: Project, Scaffold, AI tools, Agent skills, Identity, Codebase scan, Code graph, Project knowledge, Grounding + Wiki. If it asks you to confirm the AI tool, Codex should already be selected; press Enter.
2. "Code graph" starts building, with a file counter. On novu this takes about **12–15 minutes**.
3. While the graph builds, "Project knowledge" starts. A shared task plus one task per subsystem run as Codex sessions, **at most 3 at a time**. The HUD shows `N/M subsystems done`. Don't type into the terminal while agents run.
4. At the end, setup validates, writes Wiki and grounding, and reports **complete**. It then shows a Hub link for reviewing and committing. **You don't need to commit.** Once it says setup is complete, stop the Hub with Ctrl+C.

**Record:** the end time (`date`), the total time shown, the number of subsystems, and anything the HUD showed in red or yellow. Take a screenshot of the final screen.

### 7.4 If setup stops or fails
- **"heap limit" / "out of memory" / a Node heap message:** rerun with a bigger heap:
  `NODE_OPTIONS=--max-old-space-size=6144 caffeinate -dimsu mex setup --tool codex --no-open`.
  Setup resumes: finished subsystems and a finished graph are kept. **Record** that it happened, plus the watcher's numbers at the time.
- **Codex usage limit:** setup pauses and shows the reset time. Wait, then rerun the same command; it continues.
- **The Mac froze or swapped heavily** (the watcher shows free RAM near 0): stop setup with Ctrl+C, rerun it, and **record** this. It's exactly the parallel-setup problem we want to know about.
- **Anything else red:** take a screenshot, then rerun `mex setup --tool codex --no-open` once. If the same error repeats, stop and send the screenshot plus `~/mex-eval/ws-t0/.mex/local/` (zipped) to Yashasvi.
- Never delete `ws-t0/.mex`, and never edit its files by hand.

### 7.5 Check the result
```sh
cd ~/mex-eval/ws-t0
mex wiki validate            # record the summary line
mex check --json > ~/mex-eval/setup-t0-check.json; mex check | tail -15     # record the score and issue counts
ls -la .mex/graph.db         # record the size
```
"Changed" or "drift" notices are fine here. Setup errors are not.

### 7.6 Save the T0 knowledge and graph
```sh
cd ~/mex-eval/harness
node evaluate/arm/capture-scaffold.mjs --workspace ~/mex-eval/ws-t0 --subject ~/mex-eval/novu --ref refs/eval/scaffold-aug
mkdir -p ~/mex-eval/seeds && cp ~/mex-eval/ws-t0/.mex/graph.db ~/mex-eval/seeds/aug.db
cp ~/mex-eval/ws-t0/.mex/local/setup-plan.json ~/mex-eval/setup-t0-plan.json 2>/dev/null || true
```
The capture writes a git ref inside your local novu clone. It never pushes anything anywhere.

---

## 8. Sync at T1

This brings the T0 knowledge up to the Sep 21 code, the way a real team would: the code moved on, so `mex sync` updates what changed.

### 8.1 Create the T1 workspace and bring in the T0 knowledge
```sh
cd ~/mex-eval/harness
node evaluate/arm/make-workspace.mjs --subject ~/mex-eval/novu --base 6fc9d02ea001faae1846f2e0023d4a2c83d36fd3 \
  --deps ~/mex-eval/novu/node_modules --suite evaluate/arm/suites/novu-codex.json --out ~/mex-eval/ws-t1
cd ~/mex-eval/ws-t1
rsync -a --exclude 'local/' --exclude '*.db' --exclude '*.db-*' ~/mex-eval/ws-t0/.mex/ .mex/
cp ~/mex-eval/ws-t0/AGENTS.md AGENTS.md
[ -f ~/mex-eval/ws-t0/CLAUDE.md ] && cp ~/mex-eval/ws-t0/CLAUDE.md CLAUDE.md
cp ~/mex-eval/seeds/aug.db .mex/graph.db
```
(novu's own `AGENTS.md` is identical at T0 and T1, so copying T0's version only adds the MEX parts.)

### 8.2 Move the graph from T0 to T1
Start the watcher in the second terminal, with output `~/mex-eval/sync-t1-resources.csv`. Then:
```sh
cd ~/mex-eval/ws-t1
date
caffeinate -dimsu mex graph refresh        # record the time and the last lines (incremental or full, and why)
mex wiki rebuild-index
mex check | tail -20                        # record: how many facts are flagged as changed
```
About 865 source files change between T0 and T1. Refresh may decide that a full rebuild is cheaper and do one by itself (about 12–15 min). Both outcomes are fine; just **record** which happened.

### 8.3 Run sync
```sh
cd ~/mex-eval/ws-t1
caffeinate -dimsu mex sync
```
- If it asks which AI tool to use, choose **Codex**.
- Sync opens an interactive Codex session with the sync brief. Let it work, and don't give it extra instructions. If it asks you a question, answer in the most neutral way ("use your judgement" / "yes, continue"), and **record** the question and your answer.
- When the agent says it's done, exit Codex (`/quit`, or Ctrl+C twice). `mex sync` then finishes its own checks.
- If sync offers a review of individual groundings, accept its defaults. **Record** what it asked.

### 8.4 Check and save the T1 knowledge and graph
```sh
cd ~/mex-eval/ws-t1
date                                   # record the end time
mex wiki validate
mex check --json > ~/mex-eval/sync-t1-check.json; mex check | tail -15     # record
cd ~/mex-eval/harness
node evaluate/arm/capture-scaffold.mjs --workspace ~/mex-eval/ws-t1 --subject ~/mex-eval/novu --ref refs/eval/scaffold-sep
cp ~/mex-eval/ws-t1/.mex/graph.db ~/mex-eval/seeds/sep.db
printf '{ "aug": "%s", "sep": "%s" }\n' ~/mex-eval/seeds/aug.db ~/mex-eval/seeds/sep.db > ~/mex-eval/seeds/seed-graphs.json
cat ~/mex-eval/seeds/seed-graphs.json
```

### 8.5 Free the space
Before deleting, zip both workspaces' MEX folders for the results (section 11):
```sh
cd ~/mex-eval
tar --exclude='*.db' --exclude='*.db-*' -czf scaffold-t0.tgz -C ws-t0 .mex AGENTS.md
tar --exclude='*.db' --exclude='*.db-*' -czf scaffold-t1.tgz -C ws-t1 .mex AGENTS.md
rm -rf ws-t0 ws-t1        # safe: their node_modules entries are links; rm removes the links, not ~/mex-eval/novu/node_modules
du -sh ~/mex-eval/novu/node_modules   # must be unchanged from step 6
```

---

## 9. Check, then the pilot

### 9.1 Free checks (no Codex)
```sh
cd ~/mex-eval/harness
SUITE=evaluate/arm/suites/novu-codex.json
node evaluate/arm/index.mjs --validate-suite --suite $SUITE
node evaluate/arm/index.mjs --plan --suite $SUITE
```
Both must finish without errors. The plan lists 13 tasks × 3 arms.

### 9.2 Confirm the top effort level
```sh
codex exec -c model_reasoning_effort="xhigh" "Reply with the single word ok" < /dev/null
```
If it answers `ok`, the top level is `xhigh`. If it errors, use the top level the error message lists, and **record** which one.

### 9.3 Pilot: 2 tasks × 3 arms, at high and at the top level
The pilot tasks are PR 12875 and PR 12774. Each command is resumable. If it stops, run exactly the same command again.
```sh
cd ~/mex-eval/harness
COMMON="--suite evaluate/arm/suites/novu-codex.json --subject $HOME/mex-eval/novu --cli-bin $HOME/mex-eval/cli/node_modules/.bin --deps $HOME/mex-eval/novu/node_modules --seed-graphs $HOME/mex-eval/seeds/seed-graphs.json --pilot-tasks"
caffeinate -dimsu node evaluate/arm/index.mjs --pipeline --resume $COMMON --effort high  --output $HOME/mex-eval/results-pilot-high  2>&1 | tee -a ~/mex-eval/pilot-high.log
caffeinate -dimsu node evaluate/arm/index.mjs --pipeline --resume $COMMON --effort xhigh --output $HOME/mex-eval/results-pilot-xhigh 2>&1 | tee -a ~/mex-eval/pilot-xhigh.log
```
What happens, per base:
1. The harness waits until RAM and disk are free enough, and prints `[resources] ... ready`.
2. It makes the graph for that base by refreshing from the seed.
3. It runs each arm's session (`[arm] ...` lines), grades it with the hidden tests, then deletes that base's workspaces.

Each session runs Codex non-interactively; you'll only see the harness's lines. A novu session typically takes 5–30 minutes.

Afterwards, open `results-pilot-high/report.md` and `results-pilot-xhigh/report.md`. Every row must show **Valid = true**.
- If a row is invalid, its `Violations` column says why. Run the same command again with `--resume`: it reruns only invalid rows.
- If the same row stays invalid twice, stop and send that results folder (section 11).

### 9.4 Pick the effort
Compare the two reports:
- **Correct** (hidden tests passed);
- **Processed tokens** per arm;
- **Agent ms**.

Rule:
- If the top level is correct on more rows than `high` (across all 6 pairs), use the top level for the full run.
- If correctness is equal and the top level is more than 1.5× slower, use `high`.
- Otherwise, use the top level.

**Record** the choice and the reason. Send both pilot folders to Yashasvi now (section 11), and start the full run without waiting for a reply.

---

## 10. Full run: 13 tasks × 3 arms

```sh
cd ~/mex-eval/harness
EFFORT=high        # or xhigh: the effort you chose in 9.4
COMMON="--suite evaluate/arm/suites/novu-codex.json --subject $HOME/mex-eval/novu --cli-bin $HOME/mex-eval/cli/node_modules/.bin --deps $HOME/mex-eval/novu/node_modules --seed-graphs $HOME/mex-eval/seeds/seed-graphs.json"
caffeinate -dimsu node evaluate/arm/index.mjs --pipeline --resume $COMMON --effort $EFFORT --output $HOME/mex-eval/results-full-$EFFORT 2>&1 | tee -a ~/mex-eval/full-$EFFORT.log
```
- **Expected:** 39 sessions, roughly 15–30 hours. Bases run in date order: the August tasks first (from the T0 seed), then Sep–Oct (from the T1 seed).
- **Interruptions:** a reboot, a usage limit, closing the lid or Ctrl+C. Run **the same command** again. `--resume` skips finished rows, reruns invalid ones and cleans up half-finished work. Never change the effort, model or any path between resumes; the harness refuses a changed configuration on the same output folder, by design.
- **Your Mac during the run:** keep it on power, awake and lightly used. Don't run another harness, a build or a big download at the same time; RAM pressure and CPU load change the timings.
- **Progress:** `ls ~/mex-eval/results-full-$EFFORT/runs | wc -l` counts finished rows (it should reach 39). `tail -5 ~/mex-eval/full-$EFFORT.log` shows the current step.
- **Done:** the command ends normally and `report.md` lists 39 rows, all **Valid = true**.

### 10.1 Price the run at API list rates
Codex Pro is a subscription, so sessions carry no dollar cost. Every token is recorded, though, so we price the run as if it had used the API:

1. Open OpenAI's API pricing page and find **`gpt-6.1-sol`**. Note three rates in dollars per **million** tokens: input, cached input and output. Reasoning tokens are billed as output and are already counted in output. If the page lists a separate cache-write price, note it too. **Record** the rates, the page URL and today's date in your notes. Don't guess a rate: if the model isn't listed, write that down and skip this step.
2. Price the full run and both pilots, replacing `IN`, `CACHED` and `OUT` with the three rates (add `--cache-write <rate>` only if one is listed):
```sh
cd ~/mex-eval/harness
for R in results-full-$EFFORT results-pilot-high results-pilot-xhigh; do
  node evaluate/arm/list-price.mjs --runs $HOME/mex-eval/$R/runs --input IN --cached-input CACHED --output OUT \
    --csv $HOME/mex-eval/$R/list-price.csv | tee $HOME/mex-eval/$R/list-price.md
done
```
Each `list-price.md` has:
- **per arm:** valid rows, correct rows, processed tokens and two prices;
  - **Billed $:** uncached input at the input rate, cached input at the cached rate, output at the output rate. This is what the API would have charged.
  - **Neutral $:** every input token at the full input rate. The prompt cache, and so the order the sessions ran in, can't move this number, so it's the fair comparison between arms.
- **per MEX arm vs `files`:** the geometric mean of the per-task ratios for neutral $ and processed tokens. 1.000 means equal; 0.600 means 40% less.

`list-price.csv` has the per-row prices.

---

## 11. What to send back

```sh
cd ~/mex-eval
tar --exclude='*.db' --exclude='*.db-*' --exclude='*/ws/*' --exclude='*/index-cache/*' \
  -czf novu-codex-results.tgz \
  results-pilot-high results-pilot-xhigh results-full-* \
  scaffold-t0.tgz scaffold-t1.tgz \
  setup-t0-*.csv setup-t0-*.json sync-t1-*.csv sync-t1-*.json \
  *.log notes.md
ls -lh novu-codex-results.tgz
```
Send `novu-codex-results.tgz` (a drive link is fine if it's big) plus the setup screenshots.

What the archive holds, so you know nothing is missing:
- **`results-*/runs/*.json`:** one row per session. Validity, hidden-test result, tokens (input, cached, output, reasoning), time, tool calls by kind, hook events, peak memory.
- **`results-*/artifacts/`:** per session, the Codex event stream (`*.jsonl`), the Codex transcript (`*.rollout`), the agent's diff (`*.patch`), hidden-test output (`*.tests.txt`), the MEX hook log (`*.context-log.jsonl`), the knowledge check before and after (`*.check.json`), and memory samples (`*.resources.csv`). Also per base: refresh timing and mode.
- **`results-*/report.md`:** the summary table.
- **`pipeline.json`:** the exact configuration and hashes the run used.
- **`results-*/list-price.md`** and **`list-price.csv`:** the list-price cost from 10.1.

---

## 12. Run notes: what to record

Keep `~/mex-eval/notes.md` as you go. Copy this template:
```markdown
# novu × Codex run notes (Daksh)
## Machine
- macOS: / RAM bytes: / free disk at start:
- node / pnpm / codex versions:
- mex commit / tarball sha256 / harness commit:
- semantic status:
- novu node_modules size / pnpm install time:
## Setup T0
- start / end / total shown in HUD:
- subsystems: / max agents at once seen:
- watcher: peak matched RSS / lowest available RAM / lowest free disk:
- any heap error, freeze, swap, usage limit, rerun (what + when):
- wiki validate: / mex check score + counts: / graph.db size:
## Sync T1
- graph refresh: time / incremental or full (reason):
- mex check before sync (flagged facts):
- sync: start / end / questions asked and your answers:
- mex check after sync:
- watcher numbers:
## Pilot
- top effort level name:
- high vs top: correct / processed tokens / time per arm:
- chosen effort + reason:
## Full run
- start / end / number of resumes and why:
- anything unusual:
## List-price cost
- pricing page URL + date:
- gpt-6.1-sol $/M: input / cached input / output / cache write (if listed):
- full run: billed $ and neutral $ per arm; neutral ratio vs files per MEX arm:
```

---

## 13. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| `[resources] ... waiting` repeats | Free RAM < 4 GB or free disk < 5 GB | Close apps or free disk. It continues by itself. |
| A row has `agent capture failed: spawn codex ENOENT` | The harness couldn't find `codex` | `which codex` must print a path in the terminal you start the harness from. Fix PATH, then `--resume`. |
| `token accounting: missing turn.completed` | The Codex session ended abnormally (crash, network, usage limit) | `--resume` reruns it. If it repeats, check `codex login`. |
| `lexical recipe not verified` / `semantic recipe not verified` | An R2w or R3 session didn't prove which matching it used | Run `mex context semantic status`; it must say installed. Then `--resume`. If it repeats, send the folder. |
| `MEX arm session with zero hook events` | Codex didn't run MEX's hooks | Make sure you didn't edit `~/.codex/config.toml` to disable `hooks`. Send the folder. |
| `history leak: ...` | A workspace contained commits past its base | Stop. Send the message. Never work around it. |
| `pipeline configuration changed; use a separate output` | Something changed since the run started (effort, CLI, seeds, suite) | Undo the change, or start a new output folder, but tell Yashasvi first. |
| `frozen MEX CLI changed after --prepare` | `~/mex-eval/cli` was modified | Don't rebuild it mid-run. Reinstall the same tarball (check the sha256), then resume. |
| Hidden tests fail in every arm for one task | Possibly an environment problem with that task | Keep going. Note the task id in your notes; we look at it afterwards. |
| The Mac gets very slow, swap is high | Memory pressure | Let the current step finish, then pause (Ctrl+C) and resume later with fewer apps open. |
| Setup HUD stuck with no new events for > 20 min | An agent hung | Wait 30 min in all, then Ctrl+C and rerun setup (it resumes). Record it. |

---

## 14. Rules

- Use only the frozen CLI in `~/mex-eval/cli` for every MEX command.
- Never edit files under any `.mex/` folder, results folder or seed by hand.
- Never push, commit to or open PRs on the MEX repository or novu from this work. The capture refs stay in your local novu clone.
- Don't open `.db` files with other tools during a run; copy them first if you want to look.
- One harness at a time, one output folder per configuration.
- If you're unsure, stop and ask. A paused run costs nothing, while a silently wrong run costs the whole comparison.

---

## 15. Reference

| What | Value |
|---|---|
| MEX product branch | `feat/context-hooks` on github.com/mex-memory/mex (Codex hook support included) |
| Harness branch | `eval/codex-harness` |
| novu pinned install commit | `8de73e7553d6bcf03b4ce1513e1627ee8f316459` (branch `next`), pnpm 11.28.2, Node 22.23.x |
| T0 (setup) | `5f9f2d7f2360462642a58ecceb1c0051bd5af80f`, 2026-08-20 |
| T1 (sync) | `6fc9d02ea001faae1846f2e0023d4a2c83d36fd3`, 2026-09-21 |
| Model | `gpt-6.1-sol`; setup/sync effort `high`; session effort chosen by the pilot |
| Codex CLI | 0.163.0 |

Tasks (each graded by its PR's hidden tests):

| Task | Knowledge from |
|---|---|
| novu-heavy-pr-12403, 12413, 12430, 12455, 12469 | T0 setup (`scaffold-aug`) |
| novu-heavy-pr-12690, 12758, 12148, 12871, 12786, 12774, 12875, 12940 | T1 sync (`scaffold-sep`) |

How the Codex hooks are installed in MEX arms: the harness runs `mex hooks install --tool codex`, which writes `.codex/hooks.json` plus a short block in `AGENTS.md`, and starts Codex with `--dangerously-bypass-hook-trust` only in those arms. You don't do anything for this.
