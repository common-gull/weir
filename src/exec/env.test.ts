import { expect, test } from 'bun:test';
import { baseExecEnv } from './env.ts';

test('baseExecEnv forwards only the operational baseline, withholding daemon secrets', () => {
    // The baseline reaches every step; a var it doesn't name — a credential (GH_TOKEN) or any arbitrary
    // daemon var (WEIR_SNOOP) — is dropped, so a step naming no secret inherits none of the daemon's.
    const env = baseExecEnv({ PATH: '/usr/bin', GH_TOKEN: 'gh-secret', WEIR_SNOOP: 'daemon-only' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.WEIR_SNOOP).toBeUndefined();
});

test('baseExecEnv passes HOME through as an operational baseline, not a credential', () => {
    // HOME lets git/ssh and the runtimes resolve their per-user config (~/.gitconfig, ~/.ssh, ~/.bun); it
    // names no secret, so it forwards unconditionally while a real secret alongside it stays withheld.
    const env = baseExecEnv({ PATH: '/usr/bin', HOME: '/home/weir', GH_TOKEN: 'gh-secret' });
    expect(env.HOME).toBe('/home/weir');
    expect(env.GH_TOKEN).toBeUndefined();
});

test('baseExecEnv forwards non-secret operational vars (locale, tz, tmpdir, proxy) unconditionally', () => {
    // These aren't credentials, so they pass through unconditionally; withholding them silently changes
    // behavior (locale-parsed output, temp location, proxy routing) rather than protecting a secret.
    const env = baseExecEnv({
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        TZ: 'UTC',
        TMPDIR: '/scratch',
        HTTPS_PROXY: 'http://proxy:3128',
        GH_TOKEN: 'gh-secret',
    });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
    expect(env.TMPDIR).toBe('/scratch');
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(env.GH_TOKEN).toBeUndefined();
});

test('baseExecEnv omits a baseline var absent from the source', () => {
    // A baseline name the source doesn't hold adds no empty/undefined entry.
    const env = baseExecEnv({ PATH: '/usr/bin' });
    expect('HOME' in env).toBe(false);
    expect('TZ' in env).toBe(false);
});
