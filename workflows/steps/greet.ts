// An opt-in rung-1 exec step (docs/containerized-steps.md) — routed out-of-process by the
// `ctx.step(name, spec)` overload rather than run as the default host closure. Note what crosses the
// step boundary: not a lexical capture of `name` from the workflow body, but an explicit `input` the
// engine marshals into this subprocess. That explicitness is the whole point of the exec-step form.
export default ({ name }: { name: string }) => `hello, ${name}`;
