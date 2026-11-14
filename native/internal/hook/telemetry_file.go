package hook

import "github.com/mex-memory/mex/native/internal/safefile"

func safeTelemetryFile(path string) bool { return safefile.Regular(path) }
