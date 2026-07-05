"""Fixture step for runtime.test.ts: a step calling sys.exit() (SystemExit is a BaseException) must
still yield a structured error frame, not empty stdout with a bare exit code."""

import sys


def step(value):
    sys.exit("boom via sys.exit")
