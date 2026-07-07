import { resolve } from 'node:path';

process.argv[1] = resolve(process.cwd(), 'src/app/acp/index.ts');
await import('../../app/acp/index.js');
