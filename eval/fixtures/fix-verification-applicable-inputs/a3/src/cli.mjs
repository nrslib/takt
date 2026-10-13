import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchIssue } from './service.mjs';

const execAsync = promisify(exec);

export async function runCli(args) {
  if (args.length !== 2 || !/^[A-Z]+-[0-9]+$/.test(args[1])) {
    throw new Error('Usage: issue-title service-url issue-key');
  }
  const [serviceUrl, key] = args;
  const issue = await fetchIssue(serviceUrl, key);
  const { stdout } = await execAsync(`printf '%s: %s\\n' "${key}" "${issue.title}"`);
  return stdout;
}
