import { loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';

export function shouldUseGherkinTaskInstructions(projectDir: string): boolean {
  const projectValue = loadProjectConfig(projectDir).assistant?.gherkin;
  if (projectValue !== undefined) {
    return projectValue;
  }
  return loadGlobalConfig().assistant?.gherkin === true;
}
