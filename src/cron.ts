// Zero-dependency 5-field cron parser + timezone-aware next-occurrence.
// Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, 0=Sun).
// Supports  *  a  a-b  */n  a-b/n  and comma lists. Vixie dom/dow semantics: when BOTH are
// restricted, a day matches if EITHER matches; otherwise the restricted one applies.

interface Cron {
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    domStar: boolean;
    dowStar: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
    const set = new Set<number>();
    for (const part of field.split(',')) {
        let range = part;
        let step = 1;
        const slash = part.split('/');
        if (slash.length === 2) {
            const [rangePart, stepStr] = slash;
            range = rangePart ?? part;
            step = Number(stepStr);
            if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
        }
        let lo: number;
        let hi: number;
        if (range === '*') {
            lo = min;
            hi = max;
        } else if (range.includes('-')) {
            const [a, b] = range.split('-');
            lo = Number(a);
            hi = Number(b);
        } else {
            lo = hi = Number(range);
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
            throw new Error(`bad cron field "${field}" (range ${min}-${max})`);
        for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set;
}

export function parseCron(expr: string): Cron {
    const f = expr.trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`cron must have 5 fields, got ${f.length}: "${expr}"`);
    const [mi, ho, dom, mo, dow] = f as [string, string, string, string, string];
    const dowSet = parseField(dow, 0, 7);
    if (dowSet.has(7)) {
        dowSet.delete(7);
        dowSet.add(0);
    }
    return {
        minute: parseField(mi, 0, 59),
        hour: parseField(ho, 0, 23),
        dom: parseField(dom, 1, 31),
        month: parseField(mo, 1, 12),
        dow: dowSet,
        domStar: dom === '*',
        dowStar: dow === '*',
    };
}

function partsInTz(epoch: number, tz: string) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
    const p = fmt.formatToParts(new Date(epoch));
    const get = (t: string): number => {
        const part = p.find((x) => x.type === t);
        if (!part) throw new Error(`missing ${t} in formatted date`);
        return Number(part.value);
    };
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    return { mo, d, h: get('hour'), mi: get('minute'), dow };
}

function dayMatches(c: Cron, d: number, dow: number): boolean {
    if (c.domStar && c.dowStar) return true;
    if (!c.domStar && !c.dowStar) return c.dom.has(d) || c.dow.has(dow);
    return c.dom.has(d) && c.dow.has(dow);
}

/**
 * Smallest epoch strictly greater than `after` whose wall-clock in `tz` matches `expr`.
 *
 * The ~10-year search horizon is deliberate: the rarest satisfiable cron is Feb 29, whose gap
 * between occurrences stretches to 8 years across a skipped leap century (e.g. 2096 → 2104,
 * since 2100 is not a leap year). A shorter window would misreport such a valid-but-rare cron
 * as unsatisfiable. To keep that long search cheap, a day whose date can't match (wrong month
 * or day) is skipped whole rather than scanned minute by minute.
 */
export function nextFire(expr: string, tz: string, after: number): number {
    const c = parseCron(expr);
    let t = Math.floor(after / 60000) * 60000 + 60000; // strictly-next minute boundary
    const limit = 10 * 366 * 24 * 60; // ~10 years of minutes (headroom over the 8-year max gap)
    for (let scanned = 0; scanned < limit; ) {
        const { mo, d, h, mi, dow } = partsInTz(t, tz);
        if (c.month.has(mo) && dayMatches(c, d, dow)) {
            if (c.minute.has(mi) && c.hour.has(h)) return t;
            t += 60000; // date matches — walk this day's minutes
            scanned++;
        } else {
            const skip = 1440 - (h * 60 + mi); // date can't match — jump to the next day
            t += skip * 60000;
            scanned += skip;
        }
    }
    throw new Error(`no cron match within 10 years for "${expr}" (${tz})`);
}
