import { pathKey } from './path-key.js';

export class JobStore {
  #jobs = new Map();

  save(path, job) {
    this.#jobs.set(pathKey(path), job);
  }

  load(path) {
    return this.#jobs.get(pathKey(path));
  }
}
