// Bun's forced test timeout does not wait for an async body's finally. Restore spies in the runner's lifecycle
// before another test can capture a leftover spy as its "original" and recurse through mockImplementation.
import { afterEach, mock } from "bun:test";

afterEach(() => mock.restore());
