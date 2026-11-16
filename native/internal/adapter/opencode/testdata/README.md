OpenCode payloads are built by MEX's own plugin (src/install/opencode-plugin.ts)
from the plugin hooks' arguments, so these fixtures are the plugin's format.
The fields it copies (`tool`, `args`, `output`, `metadata.exit`, the child
session's `parentID`) follow the OpenCode plugin docs (checked 15 Nov 2026)
and are confirmed by the live test.
Regenerate `*.event.json` with `go test ./internal/adapter/opencode -update`.
