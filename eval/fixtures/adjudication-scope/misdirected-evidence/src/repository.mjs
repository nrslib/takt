import { query } from './driver.mjs';
export const range = async (store, offset, size) => (await query(store, { offset, limit: size })).rows;
