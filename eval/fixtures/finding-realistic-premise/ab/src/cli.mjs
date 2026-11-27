import { listFiles } from './list.mjs';
if (process.argv[2] !== 'list') throw new Error('Specify list');
console.log(listFiles(process.cwd()));
