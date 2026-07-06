// A rung-1 exec step (docs/containerized-steps.md): weir spawns this module in a subprocess via the
// node runtime shim and memoizes its JSON return. Authoring contract is just `export default
// (input) => output`; this step takes no input.
export default () => 'world';
