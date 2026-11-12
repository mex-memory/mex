// mex-hook is the program every agent hook runs. It must start fast, never
// block the agent, and always exit 0 with valid JSON.
package main

import (
	"os"

	"github.com/mex-memory/mex/native/internal/hook"
)

func main() {
	os.Exit(hook.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, os.Getenv))
}
