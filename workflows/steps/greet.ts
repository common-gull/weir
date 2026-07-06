// A rung-1 exec step (docs/containerized-steps.md). Note what crosses the step boundary: not a
// lexical capture of `name` from the workflow body, but an explicit `input` the engine marshals into
// this subprocess. That explicitness is the whole point of the exec-step model.
export default ({ name }: { name: string }) => `hello, ${name}`;
