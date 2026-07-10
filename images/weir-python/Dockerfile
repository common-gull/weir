# weir base image for the python runtime authoring form (#C8). The base is pinned by digest so a
# step's container runs exact bytes — the same reproducibility discipline the engine applies when it
# pins a step's image in the run memo (src/exec/docker.ts). The protocol shim is baked at /opt/weir/
# (CONTAINER_WEIR_DIR in src/exec/runtime.ts), where a runtime-form step's module is bind-mounted
# alongside it and dispatch invokes `python3 /opt/weir/python-shim.py /opt/weir/module.py`. The python
# shim reimplements the wire protocol in pure Python, so it needs nothing beyond the interpreter.
#
# Build context is the repo root so COPY can reach the shim source: `bun run images:build`.
FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

COPY src/exec/shims/python-shim.py /opt/weir/python-shim.py
