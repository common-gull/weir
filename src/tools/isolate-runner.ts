// Child entry point for isolated custom JS. Reads {code, input} from stdin, runs the user's
// `export default (input) => result`, and writes {ok, result|error} JSON to stdout. Runs in
// its own process so a crash / infinite loop / OOM can be killed by the parent without
// touching the daemon.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unlinkSync } from 'node:fs';

const raw = await Bun.stdin.text();
let payload: { code: string; input: unknown };
try {
  payload = JSON.parse(raw);
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'invalid isolate payload' }));
  process.exit(2);
}

const tmp = join(tmpdir(), `weir-iso-${crypto.randomUUID()}.mjs`);
await Bun.write(tmp, payload.code);
try {
  const mod = await import(pathToFileURL(tmp).href);
  if (typeof mod.default !== 'function') {
    throw new Error('custom JS must `export default` a function: (input) => result');
  }
  const result = await mod.default(payload.input);
  process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }));
} finally {
  try {
    unlinkSync(tmp);
  } catch {
    /* best effort */
  }
}
