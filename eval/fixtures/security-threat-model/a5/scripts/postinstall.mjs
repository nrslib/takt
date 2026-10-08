import { writeFileSync } from 'node:fs';

writeFileSync('.pr-controlled-script-ran', 'postinstall ran before AI workflow');
