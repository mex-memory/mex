# Durable plain notes — ticket 01

Status: working-tree implementation on `codex/log-revamp-ticket-01`, based on `7ab22a1`; unreleased. This is the plain-note slice. Retry keys, retained attachments, correction relations, Hub Context composition and code-linked recall belong to subsequent tickets.

## Agent and package interfaces

CLI: `mex log <message> [--type note|decision|risk|todo] [--file path] [--source label] [--status label] [--trace pointer] [--json]`; `mex timeline [--query text] [--file path] [--type kind] [--since date|Nd|ISO] [--limit 1..200] [--json|--format md]`; `mex note get <id> [--json]`.

The new public package boundary is `recordNote(config, input): Promise<NoteReceipt>`, `findNotes(config, query?): NoteSearchResult`, and `getNote(config, id): NoteRecord`. `NoteError`, `noteProblem` and `NOTE_LIMITS` describe stable failures and bounds. The preexisting synchronous JSONL functions retain their behavior. The source MCP workspace uses these public exports: `mex_log` actions `write`, `read`, `get`, and `mex_timeline` use the same note filters/semantics. Search defaults to 20 across both interfaces. MCP errors set `isError` and contain a versioned problem; CLI errors exit nonzero and, with `--json`, emit the same problem shape to stderr.

The caller supplies message, label, explicit related paths and optional source/status/trace labels. A file reference never copies contents. Empty messages are allowed for compatibility; text is never trimmed. Unknown inputs such as request keys/attachments are rejected by the package writer and are not advertised by the transport schemas. Configured AI tools and Git authors do not identify the invoking actor.

## Canonical representation

The configured scaffold contains `events/notes/YYYY-MM/log_<ULID>.md`, with one immutable accepted record per file. ULIDs use cryptographic randomness; every unkeyed write is independent. The ID encodes the observation month for direct lookup. Lexical time ordering is not causal ordering between machines. A collision never overwrites an existing file.

The `mex_log` YAML envelope has `schema_version: 1`, `id`, `timestamp`, `kind`, `files`, `cwd`, `context`, `origin_adapter`, optional `trace`/`source`/`status`, and the message's UTF-8 byte count and SHA-256. Generated frontmatter uses LF. Exactly one LF after the closing delimiter belongs to the envelope; every subsequent byte belongs to the supplied message, including leading/trailing whitespace, CRLF, Unicode/BOM content and missing final newline. The reader uses the existing positional Markdown parser on the header only and a strict YAML/schema validator. Body text is opaque: even Wiki entity markers are authored content. Digests detect accidental body changes, not malicious rewriting of content and hashes.

Project identity is copied only from an existing valid scaffold ID. Repository/worktree/actor/session identity remain null when not bound. Git HEAD, branch, dirty flag and observation time are obtained through the existing bounded read-only Git port before the note modifies the tree; unavailable Git observation is null. A dirty flag is not a source snapshot. Relative caller cwd is retained when within the configured project; otherwise it is unknown. No identity/config/index is initialized by these operations.

Explicit writes install an exact scoped `.gitattributes` policy with `-text -filter -ident -working-tree-encoding`, refusing conflicting existing policy or effective Git attributes. Share this file along with notes. This preserves mixed line endings under ordinary Git checkout conversion. Local Git info attributes can override committed rules; conversions introduced after capture can corrupt a checkout, which body validation reports. Arbitrary manual history rewriting is not prevented.

## Completion and failures

The writer validates/encodes the complete note, ensures the byte policy, exclusively stages and file-flushes the artifact, then publishes through a no-overwrite hard link. On supported platforms it flushes the containing directory and every naming ancestor through the repository root. It returns only after those calls complete. Existing Team callers retain best-effort directory handling; the new writer opts into strict handling, where failures propagate.

The receipt includes `schemaVersion: 1`, `state: locally_recorded`, ID, original recorded time, repository-relative path, exact artifact SHA-256 and achieved durability. It makes no claim about truth, indexing, Git publication or remote availability.

- POSIX: `file_and_directories_flushed` reports successful file and directory flush syscalls. This depends on filesystem/hardware honoring them; process-death tests do not prove physical power-loss behavior.
- Windows: `file_flushed_directory_flush_unsupported` explicitly reports the Node/OS directory-flush limitation. File contents are flushed and publication is atomic, but host/power-loss directory persistence is not promised. Human output also states this limitation. Native Windows validation remains separate from macOS execution.

If publication/flush fails, `NOTE_WRITE_UNCONFIRMED` includes the allocated ID and never claims success. A fully published candidate is preserved if acknowledgement fails; direct read establishes current availability/integrity, not proof that a previous writer acknowledged it. Do not blindly repeat an unkeyed write after uncertainty. Ticket 02 adds durable keyed recovery. Earlier accepted notes are never evicted to make space.

Readers ignore staging names and never repair or clean up. Process death before publication can leave a temporary file; explicit recovery/maintenance, not ordinary reads, owns any cleanup. Staging and accepted records share containment checks, bounded reads and full-width filesystem identity checks. External hostile filesystem mutation is handled conservatively where detected; the API does not make the repository immune to another process with write access.

## Discovery and compatibility

Literal case-insensitive message queries, exact normalized recorded file paths, label and time filters combine with AND; multiple file paths combine with OR. Sort newest observation first, ID as the Markdown tie-break; equal-time legacy entries preserve reverse append order. A complete result means a bounded observation, not a cross-process transaction snapshot.

`findNotes` emits `{ schemaVersion, events, truncated, sourceTruncated, sources, diagnostics }`. Source flags distinguish unavailable/incomplete Markdown and legacy input. Invalid/unsafe/unreadable notes are omitted with capped diagnostics. If filename enumeration cannot complete within its cap, no arbitrary directory prefix is labelled “newest”; that source is unavailable. New-ID reads remain direct. A concurrent directory mutation detected during enumeration invalidates that source; additions after a completed directory observation can appear on the next read.

Bounds: 16 KiB message, 16 KiB metadata, 32 KiB whole plain-note artifact; 16 file references of 1,024 bytes each; 1,024 bytes per optional label; 256-byte search query; 20,000 enumerated directory entries; at most 8 MiB and 10,000 records from each source; 32 diagnostics; 200 returned entries; 64 KiB serialized search text including its envelope/notices. Each attempted Markdown read reserves the full per-file bound before I/O, so it may stop slightly before the byte ceiling. Detail/write responses are bounded by validated artifact/input sizes (under 256 KiB of JSON, including worst-case escaping). Limits are implementation choices, not measured optimal values.

Legacy JSONL bytes are never rewritten or double-appended by the new writer. Fully observed legacy rows retain the existing Activity identity hash over path, logical LF offset and raw row. A legacy tail cut after the 8 MiB limit lacks the prior CRLF count: those rows remain searchable with `id: null` and `LEGACY_IDENTITY_UNAVAILABLE`, rather than fabricated replacement IDs. Legacy ID lookup beyond available bounded history returns `NOTE_LOOKUP_INCOMPLETE`. New Markdown IDs have neither limitation. No compiled graph/wiki index is needed for either source.

## Wiki ownership and validation

Wiki discovery prunes the note root, and write/migration guards treat it as note-owned regardless of user Wiki globs or path case aliases. A note labelled `decision` is still historical content. Future Hub/Wiki projections must use the note reader and preserve this ownership.

Validation lives in `test/notes.test.ts` (codec, bounds, exact text, no-index reads, containment, legacy compatibility, Git clone), `test/notes-failures.test.ts` (real permissions and fault-injected write/flush/publication), and `test/notes-integration.test.ts` (built CLI, actual MCP stdio, concurrent processes and SIGKILL before publication/after flushing). Root public/event/CLI tests and Wiki/artifact suites cover compatibility. Exact run results and platform limits are recorded in the research workspace's capture implementation area.
