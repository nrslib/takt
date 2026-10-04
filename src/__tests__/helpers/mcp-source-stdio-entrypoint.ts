import { resolve } from 'node:path';

process.argv[1] = resolve(process.cwd(), 'src/app/mcp/index.ts');
await import('../../app/mcp/index.js');
