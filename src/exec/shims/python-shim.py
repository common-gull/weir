"""Rung-1 python runtime shim. src/exec/runtime.ts spawns this as `python3 python-shim.py <module>`.

Reimplements the C1 wire protocol (src/exec/protocol.ts) in Python: a python step can't import the
TypeScript module, so the protocol — not shared code — is the contract.

stdout carries exactly one output frame, so everything the step writes to stdout is redirected to the
stderr log channel before the module loads; otherwise a stray write would corrupt the frame.
"""

import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True  # don't drop __pycache__ next to the user's module on the host

# Redirect OS-level fd 1 onto fd 2 so anything that writes to stdout — print(), os.write(1, ...), a C
# extension, or a child process that inherits stdio — lands on the stderr log channel, never on the
# output-frame stream. The single output frame is written through a private dup of the original fd 1,
# so only the shim can reach it. Rebinding sys.stdout alone would miss every writer that skips it.
_output = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr  # keep the Python-level name in step with the redirected fd


def _emit_output(frame):
    # Serialize fully before writing (allow_nan=False rejects NaN/Infinity, which aren't valid JSON per
    # RFC 8259) so a non-serializable result raises here — caught below and turned into an error frame —
    # instead of emitting a malformed frame; then the sole write reaches the real stdout intact.
    text = json.dumps(frame, allow_nan=False)
    _output.write(text)
    _output.flush()


def _run():
    if len(sys.argv) < 2 or not sys.argv[1]:
        return {"ok": False, "error": "python shim: missing module path argument"}
    module_path = sys.argv[1]

    try:
        frame = json.loads(sys.stdin.read())
    except ValueError:
        return {"ok": False, "error": "python shim: input frame is not valid JSON"}
    if not isinstance(frame, dict) or "input" not in frame:
        return {"ok": False, "error": 'python shim: input frame must be a JSON object with an "input" field'}

    spec = importlib.util.spec_from_file_location("weir_step", module_path)
    if spec is None or spec.loader is None:
        return {"ok": False, "error": f"python shim: cannot load module {module_path}"}
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    step = getattr(module, "step", None)
    if not callable(step):
        return {"ok": False, "error": "step module must define `def step(input): ...`"}

    return {"ok": True, "result": step(frame["input"])}


try:
    _emit_output(_run())
# BaseException, not Exception: a step that calls sys.exit() (raising SystemExit) or is interrupted
# (KeyboardInterrupt) must still emit a frame — otherwise the runner sees empty stdout and a bare
# non-zero exit code instead of a structured error.
except BaseException as exc:
    _emit_output({"ok": False, "error": str(exc) or f"step raised {type(exc).__name__}"})
