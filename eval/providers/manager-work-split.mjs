import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import InteractiveTopicJudge from './interactive-topic-judge.mjs';
import { runProcess } from './cli-review.mjs';

export function buildCodexReplayConfigArgs() {
  return [
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'notify=[]',
    ...['apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation']
      .flatMap((feature) => ['-c', `features.${feature}=false`]),
  ];
}

export function buildManagerReplayIsolationArgs(cli) {
  if (cli === 'claude') return ['--strict-mcp-config'];
  if (cli !== 'codex') throw new Error(`Unsupported CLI provider: ${cli}`);
  return buildCodexReplayConfigArgs();
}

export default class ManagerWorkSplitProvider extends InteractiveTopicJudge {
  id() {
    return `manager-work-split:${this.config.cli}:${this.config.model}`;
  }

  async replayIsolationArgs(_cwd, _options) {
    return buildManagerReplayIsolationArgs(this.config.cli);
  }

  async runReplay(args, options) {
    if (this.config.cli !== 'codex') return super.runReplay(args, options);
    const codexHome = join(options.cwd, 'codex-home');
    mkdirSync(codexHome);
    const sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    try {
      copyFileSync(join(sourceHome, 'auth.json'), join(codexHome, 'auth.json'));
    } catch (error) {
      // API-key authentication can run without an auth.json file.
      if (error.code !== 'ENOENT') throw error;
    }
    // Keep CODEX_HOME local to this process; eval replays may run concurrently.
    return runProcess('env', [`CODEX_HOME=${codexHome}`, 'codex', ...args], options);
  }
}
