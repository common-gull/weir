// Fixture for the host-side extractor tests (#50). Writes a declared output, then exits non-zero
// WITHOUT returning a protocol result — the stock-image shape the extractor exists to bridge. The
// node shim reroutes stdout and, on process exit, writes its own failure frame, so the engine sees a
// non-zero exit code alongside that frame. A custom `extract` reads the exit code and the captured
// artifact to decide the step's fate; the default frame decoder just fails on the shim's frame.
import { writeFileSync } from 'node:fs';

export default (input: { path: string; text: string; code: number }) => {
    writeFileSync(input.path, input.text);
    process.exit(input.code);
};
