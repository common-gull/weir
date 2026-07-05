// Notification adapter. Desktop (notify-send) with a stdout fallback; `gh:` comments and
// webhooks route through their capability-gated adapters.

import { $ } from 'bun';

export async function notify(target: string, message: string): Promise<void> {
  if (target === 'desktop') {
    const res = await $`notify-send ${'weir'} ${message}`.nothrow().quiet();
    if (res.exitCode !== 0) console.log(`[notify] ${message}`);
    return;
  }
  if (target.startsWith('webhook:')) {
    const url = target.slice('webhook:'.length);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
    }).catch((e) => console.log(`[notify] webhook failed: ${e}`));
    return;
  }
  console.log(`[notify:${target}] ${message}`);
}
