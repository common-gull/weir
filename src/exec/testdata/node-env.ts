// Fixture step for the capability-driven env policy (issue #30): reports which sensitive daemon env
// vars its subprocess can actually see, so a test can assert the child's observed environment via the
// node runtime. `hasPath` confirms the operational baseline survived (bun couldn't have spawned it
// otherwise), while GH_TOKEN / SNOOP prove credential withholding.
export default () => ({
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    SNOOP: process.env.WEIR_ENV_SNOOP ?? null,
    hasPath: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
});
