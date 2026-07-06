// The container-step body for workflows/example.ts: a relocatable `(input) => output` module the
// exec runtime (src/exec) runs in its own subprocess, speaking weir's stdio protocol. A step author
// ships just this function — no engine, daemon, or host access. See docs/containerized-steps.md.

export default (input: { name: string }): string => `hello, ${input.name}`;
