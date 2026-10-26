# Codex state-diagram rendering qualification

26 October 2026, Codex CLI 0.160.1, macOS 26.0.1 arm64, xterm-256color PTY,
60 rows. Implementation tested at PR #317 head `c74c7c9586e01d55610edb8c0b6cb79a6c1be1a0`.

The installed interactive CLI received fixed artifact-derived assistant text
through a loopback-only Responses replay. No inference service, API key, project
files, tool calls or real user conversation were used. Its own terminal renderer
processed fenced Mermaid and the deterministic text projection. The fixture
provider and CODEX_HOME were isolated under `/private/tmp`; user client settings
were unchanged. This verifies presentation, not skill discovery or agent reasoning.
The normal custom-provider configuration is described in the
[official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

| Case | Width | Observed behavior |
| --- | ---: | --- |
| Simple three-state diagram, explicitly incomplete check | 120 | Native boxes, initial marker, both event-labelled directed edges; incomplete status retained in fallback. |
| Real TLC broken invariant | 120 | Native diagram and readable ordered `1. Ready`, `2. Working via start`, `3. Complete via finish`; violated status and separate reproduction retained. |
| Nested states, independent regions and long labels | 120 | Client reports unsupported Mermaid features and displays source; MEX fallback retains both region identities, nested states and full conditions with readable wrapping. |
| Real TLC temporal failure | 80 | Native simple diagram plus the complete recorded raw temporal trace, including stuttering; no finite numbered path is invented. |

These observations establish native support for the tested simple syntax.
Nested/parallel statecharts require the text fallback in this client version;
Hub and optional image export remain available. Native terminal rendering does
not provide Hub path selection or evidence panels. Conditions and rules are
retained in the accompanying text rather than inferred from an arrow's label.
Claude Code qualification is assigned to the separate client handoff.

Redacted captures and messages remain under `/private/tmp/mex-statechart-codex-*`.
The following hashes identify the exact fixture messages and captures; they are
local qualification evidence, not a new canonical diagram or source baseline.

```json
[
  {
    "case": "simple",
    "columns": 120,
    "inputSha256": "193184caecf599a7d663583bb1fba74df590fbf3f70caaace3ff98c07652de40",
    "messageSha256": "2035937b0b2012dada45a460f03f6ad6b1f01a3a49e8222381e08ebbac8e36b4",
    "captureSha256": "8461f09f0f73e1effebb9d4e1c95e92e6cd6d5460f48353c37449161371d272b"
  },
  {
    "case": "nested",
    "columns": 120,
    "inputSha256": "242f3afa191fcdebbe1659c304d0958323641762a6060ede7a28657d73b1a2b7",
    "messageSha256": "9c1b5785fcdd1e5de7357bc01f19bbe01f625272e92b7580fc5bc8bcf3b2e070",
    "captureSha256": "b84ea9892ca572da621a5cc5998e71daa6aeabc51ca07f1ba5bb2a3e32bb6fe5"
  },
  {
    "case": "broken",
    "columns": 120,
    "inputSha256": "d50d00a2954e18820082505f595133616ae5c1c950034523ce0b26fd5181bdc4",
    "messageSha256": "cbf932b047b443e583a21528e2fb0176b93881f9e95473e7292cfd7a1ec2f76a",
    "captureSha256": "71c161db4f31fa59b0033f6fe7d07584313ab3c958c2b0b917713deae9e8805c"
  },
  {
    "case": "temporal-80",
    "columns": 80,
    "inputSha256": "6dd9930b076b512d5f15ccb119430bc97ea9a28872dbb1e0e2b7ffa58df12f81",
    "messageSha256": "a9dc7fa0de37235e351923c3c6680a969b7fed0994d7021de2cccb7c658b0d79",
    "captureSha256": "98443a3053ef90a0656724b994752515bc87b8985570d5d08ea4009440b7b302"
  }
]
```
