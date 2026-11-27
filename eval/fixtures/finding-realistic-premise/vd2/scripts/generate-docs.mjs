import fs from 'node:fs';
fs.mkdirSync('generated', { recursive: true });
fs.writeFileSync('generated/reference.md', '# Catalog\n\nLabels are sorted.\n');
