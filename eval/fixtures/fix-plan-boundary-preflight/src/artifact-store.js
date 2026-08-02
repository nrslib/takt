import { encodeJsonBase64 } from './candidates.js';

export class ArtifactStore {
  constructor(storage) {
    this.storage = storage;
  }

  write(id, value) {
    this.storage.write(encodeJsonBase64(id), { id, value });
  }

  read(id) {
    return this.storage.read(encodeJsonBase64(id));
  }
}
