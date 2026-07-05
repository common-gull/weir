// Fixture step for runtime.test.ts: exercises the node happy path plus console → log-channel
// routing (the console writes must reach stderr as log frames, never the stdout output frame).
export default (input: unknown) => {
    console.log('processing', input);
    console.warn('heads up');
    return { echoed: input, from: 'node' };
};
