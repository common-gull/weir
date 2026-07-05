"""Fixture step for runtime.test.ts: the python happy path plus print() -> log-channel routing.

The print() must reach stderr (surfacing as a log line), never the stdout output frame.
"""


def step(value):
    print("processing from python", value)
    return {"echoed": value, "from": "python"}
