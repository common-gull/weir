"""Fixture step for runtime.test.ts: a step writing straight to fd 1 (bypassing sys.stdout) must not
corrupt the single output frame — the raw bytes belong on the log channel."""

import os


def step(value):
    os.write(1, b"raw bytes straight to fd 1\n")
    return {"echoed": value, "from": "python-fd1"}
