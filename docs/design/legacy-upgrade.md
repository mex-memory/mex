# Reviewed upgrade from 0.8

`mex upgrade` reads the old scaffold and prints a bounded, exact preview. It
prepares the team side in a disposable worktree against the repository default
branch, through the same evidence/privacy gates and shared metadata/native-file
writer as `mex share`. The invoking checkout, index and machine record remain
unchanged. A partial legacy read cannot authorize conversion.

```sh
mex upgrade
mex upgrade --apply --expect <revision>
# Or explicitly push the branch and open its pull request:
mex upgrade --apply --expect <revision> --pr
```

The revision covers source bytes, base/head, proposed entries, exact file
changes, local cleanup and review findings. Changed sources, destinations,
base or local inputs require a new preview. Tracked sources must match the
default branch; unrelated dirty and staged work stays in place. Team imports
never overwrite existing identities. Logged decisions and untracked knowledge
become personal entries; original log files stay. Personal imports and approved
local cleanup apply immediately after explicit application. Tracked changes are
committed to a separate `mex/upgrade-YYYY-MM-DD` branch. Only `--pr` pushes.

Fresh temporary worktrees are checked against the base and initialized with the
reviewed source bytes, accounting for Git's LF/CRLF conversion. Original-source
validation and recovery after initialization still compare exact bytes.

## What survives

Human AGENTS/ROUTER/context/pattern documents remain. Router rows and obsolete
setup instructions do not become delivered knowledge. Rules use the existing
rule-file converter, Wiki entries inherit their IDs, known dates remain known,
and archived/deprecated entries remain retired. Only actual root instruction
files keep rule-file provenance. Retained scaffold documents use documentation
provenance, allowing their checked rules to enter generated output after ROUTER
stops loading them. Oversized or unsupported prose
is retained and reported rather than truncated. Inbox proposals and Relays stay
in place and are reported for their later conversion.

Original code groundings use the import-only `legacy-grounding` check described
in [the entry format](knowledge-entry.md). The old node ID, MinHash and optional
body/code hashes stay unchanged. They remain unknown until explicitly reviewed;
passing documentation checks do not certify them. Unknown imported code facts
become pointers or are withheld at either storage level, and unresolved entries
do not enter generated rule files. Log decisions have empty checks.

## Cleanup and recovery

The preview includes exact managed instruction-block replacements, obsolete
SETUP/SYNC removals, unchanged MEX-owned old skill files, disposable Wiki cache
hashes and any owned watch hook removal. Outside instruction bytes, BOM and line
endings stay intact. Modified/unowned skills, links, custom hook paths and
ambiguous hooks stay in place with a review finding. No recursive deletion runs.

The 0.8 watch installer never saved a hook backup and trimmed trailing whitespace
from a pre-existing hook. Those historical bytes cannot be reconstructed. Only
an exact, wholly generated released hook is removed automatically. Mixed or
edited hooks are preserved for manual review; upgrade never claims to have
restored an unavailable original.

The local journal records approved output before applying it. `mex upgrade
--finish` resumes interrupted local writes, worktree writes, commit or explicit
PR creation. `--discard` drops only owned pending tracked output; already-applied
personal/local changes stay. Edited output, unrelated files, links or changed
branch identity stop recovery/cleanup without forcing worktree removal. A
completed checkout receipt prevents repeating the import. Existing telemetry
opt-out remains untouched; successful interactive upgrade invokes the existing
versioned, once-only notice owner. JSON previews never display that notice.

This slice does not remove the old Wiki/setup engine, convert Inbox/Relay
records, qualify the three release repositories or publish a release.
