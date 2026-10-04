import { gradeVerdicts } from './frontend-gui.mjs';
export default function assertAccepted(output) {
  return gradeVerdicts(output, 'OK');
}
