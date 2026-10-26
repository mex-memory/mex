# Runtime and client delivery

Run `node <skill-dir>/scripts/runtime.mjs` for commands. No Java or checker is installed during MEX installation or Hub launch. Requirements for explicit generation: Node >=22.5, Java >=11, TLC **1.7.4**. Set `JAVA` to your existing Java binary and `TLA2TOOLS` to your existing jar. The helper verifies SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` before use. A different jar produces an unavailable status, never a passed check.

If absent, run `node <skill-dir>/scripts/runtime.mjs setup-tlc /chosen/tool-cache/mex-statechart` (outside the repository). It announces the download, bounds bytes/time, and verifies the pinned hash before installation; set TLA2TOOLS to the printed file. The helper also reads an existing jar from `$XDG_CACHE_HOME/mex-statechart/tla2tools-1.7.4.jar` (or the normal user cache). Alternatively, explicitly download https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar into a user-selected tool cache and verify that hash. Install Java using the user's normal runtime manager if needed. Explain first-use network/setup requirements before running setup. No unverified automatic Java installation is provided. Baseline PNG export installs pinned `pele@1.8.0` and `@resvg/resvg-js@2.6.2` on explicit generation into its cache; it announces first use. The bounded parent kills the whole checker/renderer process group on cancellation or timeout.

Limits: 60 seconds, one checker per helper, one TLC worker, 512 MiB Java heap, 100,000 accepted model states, 2 MiB logs/DOT, 16 million export pixels, 512 KiB artifact, 80 states/200 transitions, 16 traces/256 steps. Use small finite constants and explicit model state constraints for tractable exploration. Exceeding limits retains an incomplete result. Do not run raw upstream entry points to evade caps.

Examples (all model/output files in scratch outside the repository):

```sh
node <skill-dir>/scripts/runtime.mjs workflow from-spec /tmp/chart/Model.tla --map /tmp/chart/Model.map.mjs --png
node <skill-dir>/scripts/runtime.mjs check /tmp/chart/candidate.json /tmp/chart/checked.json
node <skill-dir>/scripts/runtime.mjs terminal /tmp/chart/checked.json
node <skill-dir>/scripts/runtime.mjs register /tmp/chart/checked.json /path/to/repository
```

Native Mermaid support depends on the actual client/version and syntax. Codex CLI 0.160.1 was verified with simple statecharts and ordered/temporal trace text at 80/120 columns. Its native renderer rejects the tested nested/parallel syntax; provide the readable text projection for those charts. Claude Code interactive qualification is pending with a teammate; use the text fallback until support is observed. No Claude mod is required. The normalized text view preserves conditions, independent-region identities, rules, check statuses and path order. For long/nested charts, keep a compact overview and disclose omissions; the Hub's strict Mermaid 11.12.0 renderer and accessible lists provide exploration. Review labels and image export after each regeneration.
