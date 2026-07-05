// Fixture step for runtime.test.ts: a step (or a library it calls) writing straight to
// process.stdout must not corrupt the single output frame — the raw bytes belong on the log channel.
export default (input: unknown) => {
    process.stdout.write('raw progress-bar bytes\n');
    return { echoed: input, from: 'node-stdout' };
};
