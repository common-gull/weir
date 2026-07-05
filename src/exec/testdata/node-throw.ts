// Fixture step for runtime.test.ts: the module throws, so the shim must catch it and return a
// `{ ok: false, error }` frame rather than crashing without one.
export default () => {
    throw new Error('boom from node module');
};
