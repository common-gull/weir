// Fixture step for runtime.test.ts: a step that calls process.exit() before returning must still
// yield a structured frame (via the shim's exit hook), not empty stdout with a bare exit code.
export default () => {
    process.exit(0);
};
