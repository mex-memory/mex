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

Section and source hashes are `sha256:` of the text with every whitespace run
collapsed to one space and trimmed, so re-wrapping isn't a change. The
`files` map holds `sha256:` of each file's raw bytes.

A check that can't run (an unreadable or unsupported file, a URL, a kind not
built yet) uses the file-hash floor: a changed or missing file says changed,
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
