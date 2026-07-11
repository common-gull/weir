// Rung-2 image pinning (#C8): resolve a container image tag/ref to its content digest so a step's
// container is pinned to exact bytes. The digest is the step's replay identity — recorded in the
// memo, mirroring the artifact-hash-in-memo discipline (#C6) — so a resumed run executes the same
// image the first attempt did, even if the tag has since moved. Digest *parsing* is a pure string
// function (unit-tested); resolution shells out to `<runtime> image inspect`, gated in tests behind a
// runtime-availability check so `bun run check` stays green without a container runtime.

import { $ } from 'bun';

const DIGEST_RE = /sha256:[0-9a-f]{64}/;
const PINNED_SUFFIX_RE = new RegExp(`@${DIGEST_RE.source}$`);

/** Extract the canonical `sha256:<hex>` content digest from `<runtime> image inspect`'s RepoDigests
 *  output (a JSON array like `["repo@sha256:…"]`, or a bare `repo@sha256:…`). Throws when the ref
 *  carries no repo digest — an image built locally and never pushed or pulled has none, so it can't
 *  be pinned reproducibly. */
export function parseRepoDigest(output: string): string {
    const m = output.match(DIGEST_RE);
    if (!m) throw new Error(`no sha256 repo digest in image inspect output: ${JSON.stringify(output)}`);
    return m[0];
}

/** Pin an image reference to a digest: `name:tag` + `sha256:…` → `name@sha256:…`. A ref that already
 *  carries a digest or a tag has it replaced, so pinning is idempotent. A registry port (`host:5000`)
 *  survives — only a trailing `:tag` with no later `/` is stripped. */
export function pinnedImageRef(ref: string, digest: string): string {
    const name = ref.replace(PINNED_SUFFIX_RE, '').replace(/:[^/:]+$/, '');
    return `${name}@${digest}`;
}

/** Resolve an image tag/ref to its canonical `sha256:<hex>` content digest via the local container
 *  daemon. The image must already be present with a repo digest (weir pulls before pinning); this
 *  reads it rather than pulling, so it never touches the network. Rejects if the daemon is
 *  unreachable or the ref has no repo digest. `runtime` is the container binary (a docker-CLI-
 *  compatible one — podman/nerdctl); it's interpolated as the command, never fed untrusted input. */
export async function resolveImageDigest(ref: string, runtime = 'docker'): Promise<string> {
    const out = await $`${runtime} image inspect --format '{{json .RepoDigests}}' ${ref}`.text();
    return parseRepoDigest(out);
}
