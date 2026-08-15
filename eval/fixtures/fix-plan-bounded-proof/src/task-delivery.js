import { buildFailedInstructContext } from './failed-instruct.js';
import { buildProviderPrompt } from './prompt-context.js';
import { createPullRequestForTask } from './pr-action.js';
import { renderPullRequestBody } from './pull-request-body.js';

export async function deliverFailedTask(task, input, dependencies) {
  const context = buildFailedInstructContext(task, input.runs, input.reportsBySlug);
  const providerPrompt = buildProviderPrompt(
    input.locale,
    JSON.stringify(context),
    dependencies.loadPrompt,
  );
  const providerResult = await dependencies.callProvider(providerPrompt);
  const pullRequestBody = renderPullRequestBody(context.reportSummary);
  const pullRequestCreated = await createPullRequestForTask(
    task,
    dependencies,
    pullRequestBody,
  );
  return { providerResult, pullRequestCreated };
}
