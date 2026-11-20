# The review set

`review-set.json` holds 16 review comments from public pull requests in
[microsoft/typescript-go](https://github.com/microsoft/typescript-go), where
the commented code changed later in the same pull request. Each case has:

- `objected`: the changed block around the commented line, at the commit the
  reviewer commented on;
- `fixed`: the same block at the pull request's head;
- `anchor`: the line or lines the comment was left on (the comment's
  `original_start_line` to `original_line`, read from the end of its
  `diff_hunk`, new-side lines only);
- `candidates`: patterns a learner might propose, labelled by hand. `good`
  means the pattern names what the reviewer objected to; `why` says why.

The pull requests are the ones in the earlier review-replay set. Cases were
built by diffing the commented file between the two commits and taking the
changed block that covers the commented line. Comments with no change near
their line were left out.

The code excerpts are from typescript-go, licensed under the Apache License
2.0 (copyright Microsoft Corporation).

`TestSelfCheckPrecisionOnTheReviewSet` measures the self-check on it. With
`MEX_REVIEW_SET_AREAS` set to a folder holding `<case index>/` subfolders,
each case's Go package at the pull request's head, the area-share rule runs
too. Those files are too large to keep here; each case's `path` and the pull
request's head commit are enough to fetch them again.

Measured (20 Nov 2026), 41 candidates, 19 labelled good:

| Self-check | Kept | Precision | Recall |
| --- | --- | --- | --- |
| objected/fixed only (first version) | 31 | 0.61 | 1.00 |
| plus the name rules | 24 | 0.79 | 1.00 |
| plus the comment's lines | 19 | 0.95 | 0.95 |
| plus the area share (min 3 files) | 19 | 0.95 | 0.95 |

The one bad pattern still kept sits on the commented lines and names a real
call. The one good pattern dropped is a line above the commented one.
