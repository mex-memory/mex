---
{
  "mex": {
    "id": "mx_deepaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "kind": "rule",
    "scope": [
      "src/**"
    ],
    "source": {
      "type": "docs",
      "ref": "README.md"
    },
    "evidence": "docs",
    "one_line": "Use the checked loader.",
    "checks": [
      {
        "kind": "until",
        "role": "complete",
        "target": {
          "file": "package.json",
          "pointer": "/version",
          "version": "v5.0.0"
        },
        "saw": {
          "value": "4.9.0"
        },
        "files": {}
      }
    ],
    "status": "active",
    "created": "2026-11-23"
  }
}
---
Use the checked loader. It validates input.
