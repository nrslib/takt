import FrontendMediatorCoderProvider from './frontend-mediator-coder.mjs';
import { mergeCliReviewConfig } from './cli-review.mjs';

// Reuse the implementation harness's isolated HOME, skill suppression and safe mode.
export default class FrontendMediatorReviewProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return `frontend-mediator-review:${this.config.cli}:${this.config.model}`;
  }

  async callApi(prompt, context, options = {}) {
    try {
      const config = mergeCliReviewConfig(this.config, context);
      if (config.isolate_working_dir !== true) throw new Error('Review requires isolate_working_dir: true');
      if (!['codex', 'claude'].includes(config.cli)) throw new Error(`Unsupported review CLI: ${config.cli}`);
      const provider = new FrontendMediatorCoderProvider({ config: {
        ...config,
        role: 'rubric',
        provider: config.cli === 'codex' ? 'openai:codex-sdk' : 'claude',
        model_reasoning_effort: config.reasoning_effort,
      } });
      return await provider.callApi(prompt, context, options);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
