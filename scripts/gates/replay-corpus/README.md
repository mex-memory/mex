# Public replay corpus

The two seed sessions are hand-written in native JSONL formats. Claude Code
exercises the brief, prompt pointer, silent generic prompt, read pitfall, command
recipe, failure fix, edit denial, and compaction. Codex exercises the brief and
the search span. The fixture also has a changed fact and a broken recipe. Both
agents carry recorded token counts.

## Add a session

1. Record the harness session against a public subject snapshot using neutral
   paths. Review the whole recording and its entries for private text and
   secrets before adding them. Copy the native transcript or rollout JSONL
   into `sessions/` without converting it. Keep private sessions outside this
   repository.
2. Add the subject to `manifest.json` under `subjects`. Supply its `repo` and
   `commit`, and map checkout-relative source paths to corpus files in
   `files`. Include the sources and manifests needed by the checks and the
   moments. CI stages these bytes locally and builds a fresh file index.
   For a synthetic subject, set `fixture: true` and use the SHA-256 of the
   snapshot inventory as its commit. The inventory is one LF-terminated
   `<file SHA-256> <checkout-relative path>` line per file, sorted by path.
3. Add an item in `sessions` with `agent` (`claude-code` or `codex`), `file`,
   `repo`, `commit`, and its `entries`. The historical checkout root comes
   from the recording. Set `checkout_root` if the recording needs an explicit
   root. Each entry lists its `id`, corpus `file`, and expected `verdict`.
   Use ordinary team entry Markdown. For a changed or broken entry, add
   `forbidden` with the claim text that must be absent from replies. Include
   both the one-line form and the body when they differ.
4. Add each new data path to the top-level `files` map. A new digest may be
   blank until the refresh. Save the usage rows and known model labels
   for pricing. Claude Code uses the recorded input, cache creation, cache
   read, and output fields. Codex uses consecutive cumulative usage totals.

## Refresh expected replies

Build the CLI and install the Go modules first. Choose a fresh output path
outside the corpus. The refresh runs twice in fresh homes and checks prices
and stale delivery before writing a candidate. It emits no gate evidence.

```sh
npm run build
go -C native mod download
node scripts/gates/replay.mjs --refresh-expected <new-manifest.json>
```

Review each changed reply against its recorded event. Replace the corpus
`manifest.json` with the reviewed candidate. Use the new SHA-256 in
`REPLAY_CORPUS_SHA256` in `../replay.mjs`. The following command prints it.

```sh
node -e "const fs=require('node:fs'); console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync('scripts/gates/replay-corpus/manifest.json')).digest('hex'))"
```

Run `node scripts/gates/replay.mjs` and `npm run gates:test`. Review the
manifest and its digest in the same change.
