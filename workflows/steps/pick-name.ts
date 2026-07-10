// A tiny relocatable step module used by workflows/example.ts. Its `(input) => output` shape is the
// same contract weir's container runtime (`ctx.containerStep({ runtime, module })`) runs out of
// process; the example wraps it in a host closure so it needs no container.
export default () => 'world';
