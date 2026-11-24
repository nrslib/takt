import { select } from './selection.mjs';
export const defaultPageSize = 20;
export const page = (store, offset, size) => select(store, { offset, size });
