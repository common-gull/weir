"""Rung-1 python runtime shim. src/exec/runtime.ts spawns this as `python3 python-shim.py <module>`.

Reimplements the C1 wire protocol (src/exec/protocol.ts) in Python: a python step can't import the
TypeScript module, so the protocol — not shared code — is the contract.

stdout carries exactly one output frame, so user `print()` is redirected to the stderr log channel
before the module loads; otherwise a stray print would corrupt the frame.
"""

import importlib.util
import json
import sys

sys.dont_write_bytecode = True  # don't drop __pycache__ next to the user's module on the host
_real_stdout = sys.stdout
sys.stdout = sys.stderr  # user prints must not land on the output-frame stream (fd 1)


def _emit_output(frame):
    # Serialize fully before writing so a non-JSON result raises here (caught below) instead of
    # writing a half-frame; then the sole write reaches the real stdout intact.
    text = json.dumps(frame)
    _real_stdout.write(text)
    _real_stdout.flush()


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
except Exception as exc:  # any step failure (load, call, non-JSON result) becomes an error frame
    _emit_output({"ok": False, "error": str(exc)})
