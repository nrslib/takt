#!/usr/bin/env node

import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function copyMatchingFiles(sourceDir, destinationDir, extension) {
  const source = join(root, '..', sourceDir);
  const destination = join(root, '..', destinationDir);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) {
      continue;
    }
    cpSync(join(source, entry.name), join(destination, entry.name));
  }
}

function copyFile(sourcePath, destinationPath) {
  const destination = join(root, '..', destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, '..', sourcePath), destination);
}

copyMatchingFiles('src/shared/prompts/en', 'dist/shared/prompts/en', '.md');
copyMatchingFiles('src/shared/prompts/ja', 'dist/shared/prompts/ja', '.md');
copyMatchingFiles('src/shared/prompts/en/parts', 'dist/shared/prompts/en/parts', '.md');
copyMatchingFiles('src/shared/prompts/ja/parts', 'dist/shared/prompts/ja/parts', '.md');
copyFile('src/shared/i18n/labels_en.yaml', 'dist/shared/i18n/labels_en.yaml');
copyFile('src/shared/i18n/labels_ja.yaml', 'dist/shared/i18n/labels_ja.yaml');
copyMatchingFiles('src/core/runtime/presets', 'dist/core/runtime/presets', '.sh');
