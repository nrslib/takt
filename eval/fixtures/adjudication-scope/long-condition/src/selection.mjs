import { range } from './repository.mjs';
export const select = (store, options) => range(store, options.offset, options.size);
