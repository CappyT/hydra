"""Non-destructive payload for sandbox-security-audit.mjs (Linux x86_64)."""

import ctypes
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


def readable(path):
    try:
        with open(path, "rb"):
            return True
    except OSError:
        return False


def main():
    port, sentinel, runtime_canary, readonly_canary, started = sys.argv[1:]
    Path(started).write_text("payload entered\n")
    status = dict(
        line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines()
    )
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=1) as connection:
            host_reachable = connection.recv(64) == b"hydra-audit-loopback\n"
    except OSError:
        host_reachable = False

    # Only open the harness-owned canary; never change a real runtime file.
    try:
        with open(runtime_canary, "r+b"):
            runtime_writable = True
    except OSError:
        runtime_writable = False

    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # Remount only a disposable, harness-owned read-only bind. This changes
    # mount flags inside the sandbox, never any host mount or real game file.
    ctypes.set_errno(0)
    remounted = libc.mount(
        None, os.fsencode(readonly_canary), None, ctypes.c_ulong(4096 | 32), None
    ) == 0
    try:
        with open(readonly_canary, "r+b"):
            readonly_writable = True
    except OSError:
        readonly_writable = False
    # Invalid commands cannot create BPF objects or manipulate keyrings, even
    # if a filter is missing. ENOSYS is the production filter's expected errno.
    blocked = {}
    for name, number in (("bpf", 321), ("keyctl", 250)):
        ctypes.set_errno(0)
        result = libc.syscall(ctypes.c_long(number), ctypes.c_long(-1), 0, 0, 0, 0, 0)
        blocked[name] = result == -1 and ctypes.get_errno() == errno.ENOSYS

    print(json.dumps({
        "host_loopback_reachable": host_reachable,
        "netns": os.readlink("/proc/self/ns/net"),
        "caps": {key: status[key].strip() for key in (
            "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"
        )},
        "no_new_privs": status["NoNewPrivs"].strip(),
        "seccomp_blocked": blocked,
        "sentinel_readable": readable(sentinel),
        "runtime_writable": runtime_writable,
        "readonly_remounted": remounted,
        "readonly_writable": readonly_writable,
        "nested_user_namespace": subprocess.run(
            ["/usr/bin/unshare", "--user", "--map-root-user", "--mount", "/usr/bin/true"],
            capture_output=True, timeout=3, check=False,
        ).returncode == 0,
        "secret_present": "AUDIT_FAKE_SECRET" in os.environ,
    }))


if __name__ == "__main__":
    main()
