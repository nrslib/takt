import { select } from './selection.mjs';
export const page = (store, offset, size) => select(store, { offset, size });
