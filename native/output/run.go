package output

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"unicode/utf16"
)

// RunOptions is one wrapped command.
type RunOptions struct {
	Shell   string // a KnownShell
	Command string // the exact original
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
	// Raw: MEX_RAW=1, show everything as it is.
	Raw bool
	// Save saves the full output and returns its number; nil, or an error,
	// means nothing is saved and so nothing is trimmed.
	Save func(text string, exitCode int) (int, error)
}

// Run is `mex-hook run --shell <shell> -- <command>` (plan sheet 35, L4): it
// prints `$ <command>`, runs the exact command through the shell, prints its
// output (trimmed like the hook trims Claude Code's, on success only) and
// returns its exit code.
func Run(o RunOptions) int {
	fmt.Fprintf(o.Stdout, "$ %s\n", o.Command)
	cmd, err := shellCommand(o.Shell, o.Command)
	if err != nil {
		fmt.Fprintf(o.Stderr, "mex run: %v\n", err)
		return 127
	}
	cmd.Stdin = o.Stdin
	capture := &capped{limit: MaxSaved, pass: o.Stdout}
	cmd.Stdout, cmd.Stderr = capture, capture
	err = cmd.Run()
	code := exitCode(cmd, err)
	if code == 127 && cmd.ProcessState == nil {
		fmt.Fprintf(o.Stderr, "mex run: %v\n", err)
		return code
	}
	if capture.spilled {
		// Too big to hold: it already went out as it came.
		return code
	}
	text := capture.buf.String()
	if code == 0 && !o.Raw && o.Save != nil && len(text) > MinChars && Noisy(o.Command) {
		text, _ = TrimAndSave(text, code, func() (int, error) { return o.Save(text, code) })
	}
	_, _ = io.WriteString(o.Stdout, text)
	return code
}

func shellCommand(shell, command string) (*exec.Cmd, error) {
	switch shell {
	case ShellBash, ShellZsh, ShellSh:
		path, err := exec.LookPath(shell)
		if err != nil && shell != ShellSh {
			path, err = exec.LookPath(ShellSh)
		}
		if err != nil {
			return nil, err
		}
		return exec.Command(path, "-c", command), nil
	case ShellPowerShell, ShellPwsh:
		name := "powershell.exe"
		if shell == ShellPwsh {
			name = "pwsh"
		}
		path, err := exec.LookPath(name)
		if err != nil {
			return nil, err
		}
		// -EncodedCommand passes the text exactly: no Windows argument
		// quoting sits between the original and PowerShell's parser.
		return exec.Command(path, "-NoProfile", "-NonInteractive", "-EncodedCommand", EncodePowerShell(command)), nil
	}
	return nil, fmt.Errorf("unknown shell %q", shell)
}

// EncodePowerShell is the -EncodedCommand form: UTF-16LE, base64.
func EncodePowerShell(command string) string {
	units := utf16.Encode([]rune(command))
	b := make([]byte, 2*len(units))
	for i, u := range units {
		b[2*i], b[2*i+1] = byte(u), byte(u>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// exitCode is the command's own exit status; a signal is 128 + its number,
// as shells report it.
func exitCode(cmd *exec.Cmd, err error) int {
	if cmd.ProcessState == nil {
		return 127
	}
	if code := cmd.ProcessState.ExitCode(); code >= 0 {
		return code
	}
	if runtime.GOOS != "windows" {
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return 1
	}
	return 1
}

// capped holds output up to limit, then writes everything through.
type capped struct {
	buf     bytes.Buffer
	limit   int
	pass    io.Writer
	spilled bool
}

func (c *capped) Write(p []byte) (int, error) {
	if c.spilled {
		return c.pass.Write(p)
	}
	if c.buf.Len()+len(p) > c.limit {
		c.spilled = true
		if _, err := c.pass.Write(c.buf.Bytes()); err != nil {
			return 0, err
		}
		c.buf = bytes.Buffer{}
		return c.pass.Write(p)
	}
	return c.buf.Write(p)
}

// Stdin is the process's own, for the real wrapper.
var Stdin io.Reader = os.Stdin
