# The review set

`review-set.json` holds 16 review comments from public pull requests in
[microsoft/typescript-go](https://github.com/microsoft/typescript-go), where
the commented code changed later in the same pull request. Each case has:

- `objected`: the changed block around the commented line, at the commit the
  reviewer commented on;
- `fixed`: the same block at the pull request's head;
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
too. Those files are too large to keep here.
