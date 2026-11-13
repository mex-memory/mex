# Release gates

`npm run gates` runs the seven free gates and prints one table. A passing
check requires real, nonempty evidence. There are no model calls or paid runs.

```
npm run gates -- --release beta.1 --report test-results/gates/local.json
npm run gates:test
```

The release profile follows the features included in that release:

| Gate | beta.1 | beta.2 and final |
| --- | --- | --- |
| Knowledge bench | required | required |
| Graph quality | later | required |
| Compiler call graph | later | required |
| Saved-session replay | later | required |
| Overlay equals fresh build | later | required |
| Hook timing | required | required |
| Three-repo upgrade | required | required |

Later adapters remain visibly **not built** until implemented. Missing
required adapters block release. An implemented gate that fails blocks every
profile, even if its feature was scheduled later. An unavailable required
tool also blocks. Dirty checkouts cannot provide release evidence.

## Current adapters

Hook timing runs the real Go no-op process test, with its existing 17 ms median
budget and 3 ms allowance above the bare-process median on a slow host. It
records p50, p95 and maximum separately; p95 is not claimed to have a 17 ms
budget. Where present, the counters-active timing test is included too.
An environment variable cannot raise the budget or enable cached test results.

The other six benchmark adapters are **not built**. Their original datasets,
answer keys and reference reports must be restored and verified before the
adapters can report a pass. Unit tests, synthetic fixtures, or old report files
are not substitutes for those release gates. The runner currently exits with
a blocked release, even when hook timing passes.

Adapters are fixed, repository-owned functions, given the checkout root, release
profile and current OS. A future private corpus is data,
never a command to execute. Keep saved transcripts and any fixtures containing
private text outside the public repository. Do not upload raw child stdout,
stderr, session content or paths as CI artifacts. Reports admit only gate IDs,
fixed reason codes, check counts, bounded timing metrics and commit identity.

## CI and publication

`Release gates` runs on demand and for 0.9 release tags. Linux, macOS and
Windows each produce a sanitized report. The final `release-gates` check
requires all three reports, the same exact commit and release profile, clean
checkouts, and successful producer jobs. Missing or malformed evidence fails
closed. The full test suite remains in the existing Linux CI jobs.

For tagged runs, package version and tag must match. beta.1 and beta.2 tags
select their own scope; RC and final tags require all seven gates. A manual
profile cannot reduce a tagged release's requirements. This workflow does not
publish a package: the release procedure must require a green `release-gates`
check on the tagged commit before publication.

Child processes have bounded output and deadlines. A timeout or output overflow
terminates the process tree, including children holding inherited output pipes.
The parent never prints raw diagnostics. Tests cover those termination paths,
release policy, invalid evidence, and cross-OS report aggregation.
