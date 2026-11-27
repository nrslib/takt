import { createRequire } from 'node:module';

export const TSX_ESM_LOADER = createRequire(import.meta.url).resolve('tsx/esm');
