import assert from 'node:assert/strict';

import { attachmentDestination } from '../src/attachment-path.ts';

assert.equal(
  attachmentDestination('/workspace', 'attachments/note.txt'),
  '/workspace/attachments/note.txt',
);
assert.throws(() => attachmentDestination('/workspace', '../outside.txt'));
