/**
 * What `mex wiki apply --help` adds below its options.
 *
 * This is what an agent reads before it writes knowledge, so it says exactly
 * the shapes the command accepts and nothing else. Kept free of imports so the
 * CLI entry point can attach it without loading the Wiki engine.
 */
export const WIKI_APPLY_HELP = `
The file holds one operation envelope, or a JSON array of up to 200 envelopes
applied in order as one change: all are written or none, and every problem is
reported with its array index. Re-running a file skips each operation whose
opId is already applied, so fix the reported problems and re-run the whole file.

Envelope: {"opId", "type", "actor": {"kind", "id"}, "timestamp", "reason", "payload"}

groundsTo (create-entry, set-grounding) names code in one of three ways:
  {"file": "src/app.ts", "symbol": "parseBody"}   a declaration; qualify as "Router.add"
  {"file": "src/app.ts", "line": 120}             the innermost function, method or class there
  {"node": "<graph node id>"}                     an exact node id
MEX resolves the node and records its fingerprint and body hash. A reference
that matches nothing, or several declarations, is refused with the candidates.

A create-entry inserted under a heading, with no "refines" relation of its own,
is linked to the section or file that encloses it, and a file with no Wiki id
gets one. Paths in "file" are repository-relative. A create-entry into a file
that does not exist yet also gives the new file its name, description and
last_updated frontmatter; "description" in the payload sets the description.

Example (a batch in .mex/local/setup-ops/routing.json):
  [{"opId": "setup_routing_add", "type": "create-entry",
    "actor": {"kind": "agent", "id": "agent"}, "timestamp": "2026-01-01T00:00:00Z",
    "reason": "Record how routes are registered",
    "payload": {"file": "context/routing.md", "insertAt": {"at": "end-of-file"},
      "type": "fact", "title": "Routes register through Router.add",
      "body": "...", "headingDepth": 2, "status": "promoted",
      "groundsTo": [{"file": "src/router.ts", "symbol": "Router.add"}]}}]
  mex wiki apply .mex/local/setup-ops/routing.json --apply
`;
