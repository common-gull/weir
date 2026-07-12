// The operational baseline environment for an exec-step subprocess or a container step — the non-secret
// vars forwarded unconditionally, independent of any capability grant. A step that names no secret
// therefore sees none of the daemon's: secrets reach a step only through its own explicit `env`, never by
// capability. None of these names a credential, so forwarding them leaks no grant — but tooling relies on
// them, and withholding any silently changes behavior rather than protecting anything (the child already
// runs as the daemon's user with full filesystem access — the process runtime has no fs sandbox, that's
// the container runtime's job). Specifically:
//  - PATH: without it the runtime interpreter (bun/python3) can't even be located.
//  - HOME: git/ssh and the runtimes resolve their per-user config and caches through it — ~/.gitconfig
//    (user identity, credential.helper, the safe.directory allowlist git now requires),
//    ~/.ssh/known_hosts, ~/.config/gh, ~/.bun.
//  - LANG/LC_ALL/TZ: locale- and timezone-dependent output (collation, number/date formatting) that an
//    existing step may parse; dropping them shifts the child to the C/POSIX locale and system TZ.
//  - TMPDIR: the scratch location a step expects.
//  - HTTP(S)_PROXY/NO_PROXY (both cases, since tools disagree on casing): outbound routing — without it a
//    step loses connectivity in a proxied deployment.

const BASE_EXEC_ENV: readonly string[] = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
];

/** The operational baseline env, copied from `source` (the daemon env by default). Only the non-secret
 *  baseline vars pass through, so a step inherits none of the daemon's secrets — those reach it only
 *  through its own explicit `env`. A baseline name absent from `source` adds no entry. */
export function baseExecEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of BASE_EXEC_ENV) {
        const value = source[name];
        if (value !== undefined) env[name] = value;
    }
    return env;
}
