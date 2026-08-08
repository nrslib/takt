import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';

export function shouldUseGherkinTaskInstructions(projectDir: string): boolean {
  return loadProjectConfig(projectDir).assistant?.gherkin === true;
}
