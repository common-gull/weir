"""Fixture step for runtime.test.ts: a NaN result isn't valid JSON, so the shim must reject it into an
error frame rather than emit a literal `NaN` token a strict JSON.parse would choke on."""


def step(value):
    return float("nan")
