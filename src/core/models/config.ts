import { z } from 'zod/v4';
import { TaktConfigSchema } from './schemas.js';

export { TaktConfigSchema };

export type TaktConfig = z.infer<typeof TaktConfigSchema>;

export const DEFAULT_CONFIG: TaktConfig = {
  defaultModel: 'sonnet',
  agentDirs: [],
  pieceDirs: [],
  claude: {
    command: 'claude',
    timeout: 300000,
  },
};
