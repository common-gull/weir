import { expect, test } from 'bun:test';
import { nextFire, parseCron } from './cron.ts';

test('*/5 aligns to next 5-minute slot', () => {
    expect(nextFire('*/5 * * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 2, 30))).toBe(Date.UTC(2026, 0, 1, 0, 5, 0));
});

test('strictly after a matching minute', () => {
    expect(nextFire('*/5 * * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 5, 0))).toBe(Date.UTC(2026, 0, 1, 0, 10, 0));
});

test('daily 9am UTC', () => {
    expect(nextFire('0 9 * * *', 'UTC', Date.UTC(2026, 0, 1, 0, 2, 0))).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
});

test('monday 9am (2026-01-01 is Thu -> next Mon is Jan 5)', () => {
    expect(nextFire('0 9 * * 1', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
});

test('timezone: 9am America/New_York in January (UTC-5) = 14:00 UTC', () => {
    const t = nextFire('0 9 * * *', 'America/New_York', Date.UTC(2026, 0, 1, 0, 0, 0));
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(t);
    expect(p).toBe('14');
});

test('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('99 * * * *')).toThrow();
});

test('leap-day cron resolves to the next Feb 29 (a valid, rare occurrence)', () => {
    // 2028 is the next leap year after 2026; a ~1-year search window would miss it.
    expect(nextFire('0 0 29 2 *', 'UTC', Date.UTC(2026, 0, 1))).toBe(Date.UTC(2028, 1, 29, 0, 0, 0));
});

test('leap-day cron resolves across a skipped leap century (8-year gap)', () => {
    // 2100 is not a leap year, so the fire after 2096-02-29 is 2104-02-29 — the widest real gap.
    expect(nextFire('0 0 29 2 *', 'UTC', Date.UTC(2096, 2, 1))).toBe(Date.UTC(2104, 1, 29, 0, 0, 0));
});

test('a genuinely unsatisfiable cron still throws (Feb 30 never occurs)', () => {
    expect(() => nextFire('0 0 30 2 *', 'UTC', Date.UTC(2026, 0, 1))).toThrow();
});
