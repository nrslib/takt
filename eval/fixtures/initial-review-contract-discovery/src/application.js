import { diagnoseNode } from './doctor.js';
import { executionEvent } from './event-bus.js';
import { listNode } from './list-command.js';
import { nodeRecord } from './node-record.js';
import { printNode } from './node-text.js';
import { renderPreview } from './preview.js';
import { summarizeNode } from './summary.js';
import { createCheckpoint, resumeCheckpoint } from './checkpoint.js';
import { tokenA } from './execution-token-a.js';
import { tokenB } from './execution-token-b.js';
import { tokenC } from './execution-token-c.js';
import { JobStore } from './job-store.js';
import { progressText } from './progress-text.js';
import { restoreResumeNamespace, saveResumeNamespace } from './resume-codec.js';
import { statusRecord } from './status-record.js';

export function inspectNode(node) {
  return {
    preview: renderPreview(node),
    diagnostics: diagnoseNode(node),
    summary: summarizeNode(node),
    list: listNode(node),
    text: printNode(node),
    record: nodeRecord(node),
  };
}

export function inspectExecution(path, state) {
  const store = new JobStore();
  store.save(path, state);
  const checkpoint = createCheckpoint(path, state);
  const namespace = saveResumeNamespace(path.map(({ name }) => name));

  return {
    stored: store.load(path),
    checkpoint: resumeCheckpoint(path, checkpoint),
    event: executionEvent(path, 'saved'),
    retry: tokenA(path),
    recovery: tokenB(path),
    parallel: tokenC(path),
    resumed: restoreResumeNamespace(namespace),
    text: progressText(path),
    record: statusRecord(path, state),
  };
}
