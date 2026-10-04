import { attachWorkflowOpaqueRef } from '../workflow.ts';

const directResume = attachWorkflowOpaqueRef({ name: 'direct-resume' });
if (directResume.opaqueRef !== 'workflow:direct-resume') {
  throw new Error('Direct resume reference mismatch');
}

import { attachWorkflowOpaqueRef } from '../workflow.ts';

const bootstrap = attachWorkflowOpaqueRef({ name: 'bootstrap' });
if (bootstrap.opaqueRef !== 'workflow:bootstrap') {
  throw new Error('Bootstrap reference mismatch');
}
