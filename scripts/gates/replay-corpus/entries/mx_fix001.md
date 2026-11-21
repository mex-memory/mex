---
mex: {"scope":["pool.ts"],"source":{"type":"docs","ref":"README.md"},"evidence":"docs","checks":[{"kind":"source","role":"complete","target":{"file":"README.md"},"saw":{"hash":"sha256:ef96682aec60532496d2c3e7d75fe02fb5327ede9831b1ec5e234853f61dae40"},"files":{"README.md":"sha256:a3fcc1bf4e341eb293253316ea12f29968651afe1e2641cbd9b408f7f236581c"}}],"status":"active","created":"2026-11-15","id":"mx_fix001","kind":"hint","one_line":"Set the port in the local test config.","when":[{"type":"anti","match":"literal","pattern":"FIXTURE_PORT_MISSING"}]}
---
Set the port in the local test config before running the unit tests again.
