# weir base image for the node runtime authoring form (#C8). The base is pinned by digest so a
# step's container runs exact bytes — the same reproducibility discipline the engine applies when it
# pins a step's image in the run memo (src/exec/docker.ts). The protocol shim is baked at /opt/weir/
# (CONTAINER_WEIR_DIR in src/exec/runtime.ts), where a runtime-form step's module is bind-mounted
# alongside it and dispatch invokes `node /opt/weir/node-shim.ts /opt/weir/module.ts`. The shim
# imports its protocol module as `../protocol.ts`, so protocol.ts is baked one level up at /opt/; it's
# a dependency-free leaf (no bun:sqlite, no engine code) so the base image's plain node can load it.
#
# Build context is the repo root so COPY can reach the shim sources: `bun run images:build`.
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

COPY src/exec/protocol.ts /opt/protocol.ts
COPY src/exec/shims/node-shim.ts /opt/weir/node-shim.ts
