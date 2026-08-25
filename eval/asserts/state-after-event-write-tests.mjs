import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(evalDir, 'fixtures', 'state-after-event-write-tests');
const workDir = join(evalDir, '.work', 'state-after-event-write-tests');

function listFiles(root, current = root) {
  return readdirSync(current).flatMap((entry) => {
    const path = join(current, entry);
    return statSync(path).isDirectory() ? listFiles(root, path) : [relative(root, path)];
  }).sort();
}

function changedFiles() {
  const fixtureFiles = new Set(listFiles(fixtureDir));
  const workFiles = new Set(listFiles(workDir).filter((path) => !path.startsWith('.takt/')));
  const paths = new Set([...fixtureFiles, ...workFiles]);
  return [...paths].filter((path) => {
    if (!fixtureFiles.has(path) || !workFiles.has(path)) return true;
    return readFileSync(join(fixtureDir, path), 'utf8') !== readFileSync(join(workDir, path), 'utf8');
  });
}

function runWithImplementation(source, { captureTrace = false } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-state-after-event-'));
  const tracePath = join(tempDir, 'connection-trace.jsonl');
  let passed = false;
  let trace = '';
  try {
    mkdirSync(join(tempDir, 'src'));
    cpSync(join(workDir, 'tests'), join(tempDir, 'tests'), { recursive: true });
    cpSync(join(workDir, 'package.json'), join(tempDir, 'package.json'));
    writeFileSync(join(tempDir, 'src', 'connection.js'), source);
    const env = captureTrace
      ? { ...process.env, STATE_AFTER_EVENT_TRACE_PATH: tracePath }
      : process.env;
    execFileSync(process.execPath, ['--test'], { cwd: tempDir, env, stdio: 'pipe' });
    passed = true;
  } catch {
  } finally {
    trace = captureTrace && existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { passed, trace };
}

function passesWithImplementation(source) {
  return runWithImplementation(source).passed;
}

function instrumentedImplementation(updateStatus) {
  const statusUpdate = updateStatus ? 'currentStatus = nextStatus;' : '';
  const statusRead = updateStatus ? 'currentStatus' : 'initialStatus';
  return `import { appendFileSync } from 'node:fs';

const tracePath = process.env.STATE_AFTER_EVENT_TRACE_PATH;
if (tracePath === undefined) throw new Error('STATE_AFTER_EVENT_TRACE_PATH is required');
let nextConnectionId = 0;
let nextReceiverId = 0;
const receiverIds = new WeakMap();

function getReceiverId(receiver) {
  let receiverId = receiverIds.get(receiver);
  if (receiverId === undefined) {
    receiverId = nextReceiverId++;
    receiverIds.set(receiver, receiverId);
  }
  return receiverId;
}

function record(id, call, receiver) {
  appendFileSync(tracePath, JSON.stringify({ call, id, receiverId: getReceiverId(receiver) }) + '\\n');
}

export function createConnection(initialStatus) {
  const id = nextConnectionId++;
  let currentStatus = initialStatus;
  const connection = {
    reconnect(nextStatus) {
      record(id, 'reconnect', this);
      ${statusUpdate}
    },
    readStatus() {
      record(id, 'readStatus', this);
      return ${statusRead};
    },
  };
  record(id, 'create', connection);
  return connection;
}
`;
}

function hasReadReconnectRead(calls, receiverId) {
  let state = 0;
  for (const call of calls) {
    if (call.receiverId !== receiverId) continue;
    if (state === 0 && call.call === 'readStatus') state = 1;
    else if (state === 1 && call.call === 'reconnect') state = 2;
    else if (state === 2 && call.call === 'readStatus') return true;
  }
  return false;
}

function evaluateTrace(trace) {
  let records;
  try {
    records = trace.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return false;
  }

  const connections = new Map();
  for (const record of records) {
    if (record.call === 'create') {
      if (connections.has(record.id)) return false;
      if (typeof record.receiverId !== 'number') return false;
      connections.set(record.id, { receiverId: record.receiverId, calls: [] });
      continue;
    }
    const connection = connections.get(record.id);
    if (connection === undefined || typeof record.receiverId !== 'number') return false;
    connection.calls.push({ call: record.call, receiverId: record.receiverId });
  }

  const sequences = [...connections.values()];
  const reconnecting = sequences.filter(({ calls }) => calls.some(({ call }) => call === 'reconnect'));
  const allReconnectingHaveSequence = reconnecting.every(({ receiverId, calls }) => (
    hasReadReconnectRead(calls, receiverId)
  ));
  const allConnectionsObserved = sequences.every(({ calls }) => calls.length > 0);
  return reconnecting.length > 0 && allReconnectingHaveSequence && allConnectionsObserved;
}

function continuousExecutionSection(report) {
  const headingPattern = /^##\s+(?:連続実行・所有権・並行性|Continuous Execution, Ownership, and Concurrency)(?:[ \t（(].*)?$/im;
  const heading = headingPattern.exec(report);
  if (heading === null) return null;

  const remaining = report.slice(heading.index + heading[0].length);
  const nextHeading = remaining.search(/^##\s+/im);
  const end = nextHeading === -1
    ? report.length
    : heading.index + heading[0].length + nextHeading;
  return report.slice(heading.index, end);
}

function isNotApplicableLine(line) {
  return /^(?:[-*+]\s*)?(?:該当なし|not applicable)\s*[。.!．！]*$/i.test(line.trim());
}

function mentionsConnectionAndReconnect(text) {
  return /(?:connection|接続)/i.test(text) && /(?:reconnect|再接続)/i.test(text);
}

function evaluateReportEvidence(report) {
  const section = continuousExecutionSection(report);
  if (section !== null) {
    const sectionBody = section.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
    const bodyLines = sectionBody.split(/\r?\n/);
    const bodyContent = sectionBody.trim();
    const sectionIsNotApplicable = /^(?:該当なし|not applicable)\s*[。.!．！]*$/i.test(bodyContent);
    return {
      mentionsConnectionAndReconnect: mentionsConnectionAndReconnect(sectionBody),
      isApplicable: !sectionIsNotApplicable && !bodyLines.some(isNotApplicableLine),
    };
  }

  const reportContractLines = report.split(/\r?\n/).filter((line) =>
    /連続実行・所有権・並行性|ownership|reconnect|再接続|接続|connection/i.test(line),
  );
  return {
    mentionsConnectionAndReconnect: mentionsConnectionAndReconnect(report),
    isApplicable: reportContractLines.length > 0
      && reportContractLines.every((line) => !/該当なし|not applicable/i.test(line)),
  };
}

export default function assertStateAfterEventWriteTests() {
  const changes = changedFiles();
  const reportPath = join(workDir, '.takt', 'runs', 'eval', 'reports', 'test-report.md');
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const reportEvidence = evaluateReportEvidence(report);
  const instrumentedRun = runWithImplementation(instrumentedImplementation(true), { captureTrace: true });
  const runtimeIdentityEvidence = instrumentedRun.passed && evaluateTrace(instrumentedRun.trace);

  const correctImplementationPasses = passesWithImplementation(
    `export function createConnection(initialStatus) {\n`
      + `  let currentStatus = initialStatus;\n`
      + `  return {\n`
      + `    reconnect(nextStatus) { currentStatus = nextStatus; },\n`
      + `    readStatus() { return currentStatus; },\n`
      + `  };\n}\n`,
  );
  const writeOnceImplementationFails = !passesWithImplementation(
    `export function createConnection(initialStatus) {\n`
      + `  return {\n`
      + `    reconnect(_nextStatus) {},\n`
      + `    readStatus() { return initialStatus; },\n`
      + `  };\n}\n`,
  );

  const checks = [
    changes.some((path) => path.startsWith('tests/')),
    changes.every((path) => path.startsWith('tests/')),
    reportEvidence.mentionsConnectionAndReconnect,
    reportEvidence.isApplicable,
    runtimeIdentityEvidence,
    correctImplementationPasses,
    writeOnceImplementationFails,
  ];
  const names = [
    'tests-changed',
    'only-tests-changed',
    'report-names-connection-and-reconnect',
    'report-is-applicable',
    'runtime-identity-and-call-sequence',
    'correct-implementation-passes',
    'write-once-implementation-fails',
  ];
  const failed = names.filter((_, index) => !checks[index]);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'The tests observe each reconnecting connection before and after reconnect and the report mentions the connection and reconnect behavior.'
      : `Failed checks: ${failed.join(', ')}. Changed files: ${changes.join(', ')}`,
  };
}
