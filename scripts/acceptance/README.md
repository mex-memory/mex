# Windows hook command timing

Run the **Codex hook command timing** workflow on the revision being measured.
Choose `powershell.exe` or `pwsh.exe`; optionally supply a full implementation
baseline SHA to verify that native, settings and record sources have not changed.
No model, account credential or real-user setting is used.

For a local Windows run, install repository dependencies, Go, Git and Codex CLI:

```powershell
$shellPath = (Get-Command powershell.exe -CommandType Application).Source
node scripts/acceptance/codex-command-timing.mjs test-results/codex-command-timing $shellPath
```

Use a fresh output directory. The helper builds the native shim, registers an
empty fixture project, and obtains `commandWindows` from the production settings
writer. For SessionStart and UserPromptSubmit, it measures direct native
execution and the configured command through a fresh PowerShell process.
Each case has five warmups and 200 retained samples with telemetry off.

`timing.json` retains raw samples, p50/p95/max, both revisions, binary hash, OS,
shell and tool versions. Measurements include the synchronous Node harness's
process-spawn overhead; the configured command also includes shell startup.
They exclude Codex dispatch and generation. Hosted runner observations are not
a substitute for total client latency or the release gate's different fixture.

The two original acceptance runs used Windows-2022 with production sources matching
`c2883d9343be46696ff20c1a8efebe0761239702`:

- [Windows PowerShell run](https://github.com/mex-memory/mex/actions/runs/43635770171)
- [PowerShell 7 run](https://github.com/mex-memory/mex/actions/runs/43635773616)

Run the free helper checks with
`node --test scripts/acceptance/codex-command-timing.test.mjs`.
