import assert from 'node:assert/strict';
import { ReportEmitter } from '../src/report-emitter.js';
import { emitDirect } from '../src/direct.js';

const emitter = new ReportEmitter();
const event = emitDirect(emitter, 'report', { scope: 'root', iteration: 1 });

assert.deepEqual(event, { report: 'report', scope: 'root', iteration: 1 });
