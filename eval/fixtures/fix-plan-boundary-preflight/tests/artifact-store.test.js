import assert from 'node:assert/strict';
import { ArtifactStore } from '../src/artifact-store.js';
import { NameStorage } from '../src/name-storage.js';

const storage = new NameStorage();
const store = new ArtifactStore(storage);
const first = { namespace: 0x1234, sequence: 0xabcd };
store.write(first, 'first');
const reloaded = new ArtifactStore(NameStorage.reload(storage.snapshot()));
assert.equal(reloaded.read(first)?.value, 'first');
