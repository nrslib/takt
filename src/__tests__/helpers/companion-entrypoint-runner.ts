const workflowCwd = process.env.TAKT_TEST_WORKFLOW_CWD;
if (workflowCwd === undefined) {
  throw new Error('TAKT_TEST_WORKFLOW_CWD is required');
}
const entrypoint = process.env.TAKT_TEST_ENTRYPOINT;
if (entrypoint === undefined) {
  throw new Error('TAKT_TEST_ENTRYPOINT is required');
}

process.chdir(workflowCwd);

try {
  if (entrypoint === 'runtime') {
    await import('../../app/cli/index.js');
  } else if (entrypoint === 'preview') {
    const identifier = process.env.TAKT_TEST_WORKFLOW_IDENTIFIER;
    if (identifier === undefined) throw new Error('TAKT_TEST_WORKFLOW_IDENTIFIER is required');
    const { previewPrompts } = await import('../../features/prompt/preview.js');
    await previewPrompts(workflowCwd, identifier);
  } else if (entrypoint === 'doctor') {
    const workflowPath = process.env.TAKT_TEST_WORKFLOW_PATH;
    if (workflowPath === undefined) throw new Error('TAKT_TEST_WORKFLOW_PATH is required');
    const { doctorWorkflowCommand } = await import('../../features/workflowAuthoring/doctor.js');
    await doctorWorkflowCommand([workflowPath], workflowCwd);
  } else {
    throw new Error(`Unknown TAKT_TEST_ENTRYPOINT: ${entrypoint}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
