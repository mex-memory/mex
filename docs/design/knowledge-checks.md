# Knowledge checks and verdicts

Each entry carries small checks (`docs/design/knowledge-entry.md`, "Check
syntax"). The evaluator in `native/check` runs them and gives the entry a
verdict. It reads repository files only: no commands, no network, no model.

## Verdicts

| Verdict | When |
| --- | --- |
| broken | The entry is retired, or a complete check fails or its target is gone |
| changed | A supporting check fails or is gone, or a check that can't be evaluated has a recorded file that changed or is missing |
| unknown | A check can't be evaluated and recorded no files, or the entry has no checks |
| held | Every check passes. Files around a passing check may have changed |

The worst outcome wins: broken, then changed, then unknown, then held.

## What each kind reads

| Kind | Reads | Passes when |
| --- | --- | --- |
| key | The value at a JSON Pointer in a JSON (comments and trailing commas allowed) or YAML file | The value equals `saw.value` |
| command | The script at the pointer in a JSON or YAML file, or the target in a Makefile (`/name`) | It exists, as `saw.exists` says |
| section | The text under the first Markdown heading named exactly `heading`, up to the next heading of the same or a higher level; fenced code is skipped | Its hash equals `saw.hash` |
| source | A repository file. URL sources need the network and fall back to the file hashes | Its hash equals `saw.hash` |
| value | A literal at a dotted path (`defaults.allowMethods`): the first name is a top-level `const`/`let`/`var` (or `NAME =` in Python), the rest are object keys. JSON and YAML files use the path as a pointer | The literal, compared as data, equals `saw.value` |
| symbol | The definition's lines, from the file index's outline (`Router.match` follows the parent chain), as tokens | Its fingerprint equals `saw.fingerprint` |
| pattern | The file index's count of a literal pattern in `scope` | The count equals `saw.count` |

Section and source hashes are `sha256:` of the text with every whitespace run
collapsed to one space and trimmed, so re-wrapping isn't a change. The
`files` map holds `sha256:` of each file's raw bytes.

A value that is no longer a plain literal (a call, a variable, a template
string) can't be compared and falls back to the file hashes.

A symbol fingerprint is `t1:<kind>:<32 hex>`: SHA-256 over the definition's
tokens with comments, layout, quote style, JavaScript semicolons and trailing
commas dropped, and the symbol's own name left out. When the symbol isn't in
its file any more, the evaluator re-links it: it fingerprints the
definitions with the same name in other files (moved), then the other
definitions of the same kind in the same file (renamed), at most 64, and
passes if one matches. Nothing is stored per node. If the file index's copy
of the file is older than the file, the span is used only when its first
line still carries the name.

Pattern counts come from the file index, which counts the literal patterns
listed in its `patterns.json` and re-counts on refresh. A pattern the index
doesn't count yet, or a structural pattern, falls back to the file hashes.
A pattern check records no files: its count covers the whole scope.

A check that can't run (an unreadable or unsupported file, a URL, no file
index, a relation check, which the graph will evaluate) uses the file-hash
floor: a changed or missing file says changed,
so nothing is skipped silently.

Files are read through the checkout root: a path that leaves the checkout,
including through a link, is unreadable. Files over 4 MiB are unreadable.

## Writing a check

`Evaluator.Record(kind, role, target)` reads today's code, fills in `saw` and
`files`, and refuses a check that wouldn't pass. Writers use it, so every
stored check passed when it was written.

## Dependencies

`go.yaml.in/yaml/v3` v3.0.4 (MIT and Apache-2.0) reads entry frontmatter and
YAML config. Aliases, anchors and custom tags in entries are refused, as in
the Node codec.
