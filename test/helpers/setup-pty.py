"""Run one bounded terminal acceptance plan using only the Python standard library.

The plan arrives on stdin as JSON. Actions wait for output, send terminal input,
or signal only the CLI parent. Failure cleanup owns the entire PTY process group.
"""

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import sys
import termios
import time
import urllib.parse


def main():
    plan = json.load(sys.stdin)
    child, master = pty.fork()
    if child == 0:
        try:
            os.chdir(plan["cwd"])
            environment = os.environ.copy()
            for name in plan.get("unsetEnv", []):
                environment.pop(name, None)
            environment.update(plan.get("env", {}))
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", plan.get("rows", 40), plan.get("columns", 140), 0, 0))
            os.execvpe(plan["command"][0], plan["command"], environment)
        except Exception as error:
            os.write(2, str(error).encode())
            os._exit(127)

    output = bytearray()
    events = []
    status = None
    eof = False
    cursor = 0
    failure = None
    deadline = time.monotonic() + plan.get("timeoutMs", 20000) / 1000
    max_bytes = plan.get("maxBytes", 1024 * 1024)

    def poll():
        nonlocal status
        if status is None:
            finished, value = os.waitpid(child, os.WNOHANG)
            if finished:
                status = value

    def read_once(wait=0.05):
        nonlocal eof
        if not eof and select.select([master], [], [], wait)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                output.extend(chunk)
                if len(output) > max_bytes:
                    raise RuntimeError("PTY output exceeded its byte limit")
            else:
                eof = True
        elif eof:
            time.sleep(min(wait, 0.01))
        poll()

    def plain():
        value = output.decode("utf-8", errors="replace")
        value = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", value)
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value).replace("\r", "")

    def check_time():
        if time.monotonic() >= deadline:
            raise RuntimeError("PTY scenario timed out")

    try:
        for action in plan.get("actions", []):
            event = {}
            if "expect" in action:
                pattern = action["expect"] if action.get("regex") else re.escape(action["expect"])
                while True:
                    match = re.search(pattern, plain()[cursor:])
                    if match:
                        cursor += match.end()
                        event["match"] = match.group(0)
                        break
                    check_time()
                    if status is not None and eof:
                        raise RuntimeError("CLI exited before expected output: " + action["expect"])
                    read_once()
            for path in action.get("missing", []):
                if os.path.lexists(os.path.join(plan["cwd"], path)):
                    raise RuntimeError("Setup wrote before confirmation: " + path)
            if action.get("quietMs"):
                start = len(output)
                until = time.monotonic() + action["quietMs"] / 1000
                while time.monotonic() < until:
                    check_time()
                    read_once(min(0.05, max(0, until - time.monotonic())))
                event["quietOutput"] = output[start:].decode("utf-8", errors="replace")
            if action.get("probe"):
                address = urllib.parse.urlsplit(event["match"])
                with socket.create_connection((address.hostname, address.port), timeout=2):
                    event["connected"] = True
            if "input" in action:
                # A frame can be painted before React installs its input effect.
                # Model a human keypress, rather than injecting into that gap.
                until = time.monotonic() + action.get("settleMs", 100) / 1000
                while time.monotonic() < until:
                    check_time()
                    read_once(min(0.02, max(0, until - time.monotonic())))
                os.write(master, action["input"].encode())
            if "signal" in action:
                os.kill(child, getattr(signal, action["signal"]))
            events.append(event)
        while status is None:
            check_time()
            read_once()
        # Capture the closing summary without waiting on a potentially leaked child.
        until = time.monotonic() + 0.2
        while not eof and time.monotonic() < until:
            read_once()
    except Exception as error:
        failure = str(error)
        try:
            os.killpg(child, signal.SIGTERM)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 0.75
        while status is None and time.monotonic() < until:
            read_once()
        try:
            os.killpg(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if status is None:
            _, status = os.waitpid(child, 0)
    finally:
        os.close(master)

    json.dump({
        "exitCode": os.waitstatus_to_exitcode(status),
        "output": plain(),
        "raw": output.decode("utf-8", errors="replace"),
        "events": events,
        "error": failure,
    }, sys.stdout)


if __name__ == "__main__":
    main()
