# Offline delivery comparisons

These tools execute the built hook and deterministic checks. They never run
commands recorded in a transcript, call a model service, or download models.
Private corpora, sessions, models and reports stay outside this repository.

Build the hook with `CGO_ENABLED=0`. Supply absolute paths for these arguments:

```
node scripts/delivery-replay/evaluate.mjs --qset <data> --sessions <transcript-root> --binary <hook> --learned 1 --output <runs>/prompts.json
node scripts/delivery-replay/run.mjs --qset <data> --sessions <transcript-root> --sources <sources.json> --binary <hook> --base <base-hook> --output <runs>/sessions
node scripts/delivery-replay/similarity.mjs --qset <data> --binary <hook> --output <runs>/similarity.json
node scripts/delivery-replay/word-study.mjs --qset <data> --output <runs>/words.json
```

Development is the default split. The reviewer can evaluate the sealed prompt
or session split by adding `--split test` to its command. Training always reads
development prompts and their development extension; it has no test mode.
Written aliases are an evaluation ablation, not an entry-file extension.

Development evaluation also reports counts for real typed turns from the
development sessions: queries, sent, wrong and helped. This fixed check uses
the frozen gate with derived aliases only and never tunes on those turns.
With `MEX_DELIVERY_TRACE=1`, replay writes per-event phase durations to the
operational timing sidecar. Canonical semantic output stays unchanged.

`sources.json` maps corpus repository names to read-only current checkouts.
The runner makes bounded copies of check targets, touched files and native
instructions. Historical edits are observed, not applied. Each labelled
transcript gets an independent context; subagent contexts use their smaller
budget. Session labels identify entries useful at some point, not event-level
ground truth. Missing check files remain missing; no held verdict is invented.
Hints without source-eligibility evidence stay gated.

`replay.json` contains canonical semantic results. Operational timings and
fail-open diagnostics go in `timing.json`; a storage deadline is visible and
must be considered when comparing runs. Persistent-binary replay timings omit
startup. Cold hook comparisons use the opt-in Go tests and require a base
binary in the same interleaved run. A base controller can use the identical
`replay.go` driver with only its scorer-override assignment omitted.

The ranking improvement loop uses five folds with seed 20261115, stratified by
repository and prompt kind. Feature normalization, L2 and the abstention
threshold are fitted inside each training fold. Compare held-out helped minus
twice wrong; report spread and in-sample results separately. Reproduce rounds:

```
node scripts/delivery-replay/train.mjs --qset <data> --binary <hook> --mode lexical --output <runs>/round-1.json
node scripts/delivery-replay/train.mjs --qset <data> --binary <hook> --mode bm25f --previous <runs>/round-1.json --output <runs>/round-2.json --freeze <export.go>
node scripts/delivery-replay/train.mjs --qset <data> --binary <hook> --mode bm25f-common --previous <runs>/round-2.json --output <runs>/round-3.json
```

The winner is BM25F plus learned abstention; the common-word round did not
improve held-out results, so the loop stopped. The export includes the complete
gate API and numeric arrays; review it before replacing `rank/frozen.go`.

The accepted embedding study uses the original lexical scoring mode and
external local model/runtime paths from an operator-supplied manifest:

```
node scripts/delivery-replay/embeddings.mjs --qset <data> --binary <hook> --models <manifest.json> --split dev --output <runs>/embeddings.json
```

No dense model qualified for the ordinary hook. The transformer comparison
is an offline ceiling only. Licences and model paths belong in the private
manifest, not runtime dependencies.

Run the synthetic real-controller golden fixture with:

```
npx vitest run scripts/delivery-replay/replay.test.js --maxWorkers=2
```

It converts a tiny public transcript, tests containment, and compares repeated
real-binary outputs byte for byte for all four admission settings. The golden
contains neither private source data nor random receipt ids or clock times.
