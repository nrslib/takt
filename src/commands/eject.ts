/**
 * /eject command implementation
 *
 * Copies a builtin workflow (and its agents) to ~/.takt/ for user customization.
 * Once ejected, the user copy takes priority over the builtin version.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getGlobalWorkflowsDir, getGlobalAgentsDir, getBuiltinWorkflowsDir, getBuiltinAgentsDir } from '../config/paths.js';
import { getLanguage } from '../config/globalConfig.js';
import { header, success, info, warn, error } from '../utils/ui.js';

/**
 * Eject a builtin workflow to user space for customization.
 * Copies the workflow YAML and related agent .md files to ~/.takt/.
 * Agent paths in the ejected workflow are rewritten from ../agents/ to ~/.takt/agents/.
 */
export async function ejectBuiltin(name?: string): Promise<void> {
  header('Eject Builtin');

  const lang = getLanguage();
  const builtinWorkflowsDir = getBuiltinWorkflowsDir(lang);

  if (!name) {
    // List available builtins
    listAvailableBuiltins(builtinWorkflowsDir);
    return;
  }

  const builtinPath = join(builtinWorkflowsDir, `${name}.yaml`);
  if (!existsSync(builtinPath)) {
    error(`Builtin workflow not found: ${name}`);
    info('Run "takt /eject" to see available builtins.');
    return;
  }

  const userWorkflowsDir = getGlobalWorkflowsDir();
  const userAgentsDir = getGlobalAgentsDir();
  const builtinAgentsDir = getBuiltinAgentsDir(lang);

  // Copy workflow YAML (rewrite agent paths)
  const workflowDest = join(userWorkflowsDir, `${name}.yaml`);
  if (existsSync(workflowDest)) {
    warn(`User workflow already exists: ${workflowDest}`);
    warn('Skipping workflow copy (user version takes priority).');
  } else {
    mkdirSync(dirname(workflowDest), { recursive: true });
    const content = readFileSync(builtinPath, 'utf-8');
    // Rewrite relative agent paths to ~/.takt/agents/
    const rewritten = content.replace(
      /agent:\s*\.\.\/agents\//g,
      'agent: ~/.takt/agents/',
    );
    writeFileSync(workflowDest, rewritten, 'utf-8');
    success(`Ejected workflow: ${workflowDest}`);
  }

  // Copy related agent files
  const agentPaths = extractAgentRelativePaths(builtinPath);
  let copiedAgents = 0;

  for (const relPath of agentPaths) {
    const srcPath = join(builtinAgentsDir, relPath);
    const destPath = join(userAgentsDir, relPath);

    if (!existsSync(srcPath)) continue;

    if (existsSync(destPath)) {
      info(`  Agent already exists: ${destPath}`);
      continue;
    }

    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(srcPath));
    info(`  ✓ ${destPath}`);
    copiedAgents++;
  }

  if (copiedAgents > 0) {
    success(`${copiedAgents} agent file(s) ejected.`);
  }
}

/** List available builtin workflows for ejection */
function listAvailableBuiltins(builtinWorkflowsDir: string): void {
  if (!existsSync(builtinWorkflowsDir)) {
    warn('No builtin workflows found.');
    return;
  }

  info('Available builtin workflows:');
  console.log();

  for (const entry of readdirSync(builtinWorkflowsDir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    if (!statSync(join(builtinWorkflowsDir, entry)).isFile()) continue;

    const name = entry.replace(/\.ya?ml$/, '');
    info(`  ${name}`);
  }

  console.log();
  info('Usage: takt /eject {name}');
}

/**
 * Extract agent relative paths from a builtin workflow YAML.
 * Matches `agent: ../agents/{path}` and returns the {path} portions.
 */
function extractAgentRelativePaths(workflowPath: string): string[] {
  const content = readFileSync(workflowPath, 'utf-8');
  const paths = new Set<string>();
  const regex = /agent:\s*\.\.\/agents\/(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }

  return Array.from(paths);
}
