/**
 * Catch-block logging rules.
 *
 * The project policy (builtins facets: coding policy "Fail Fast — never
 * swallow errors") requires a failure that is logged inside a catch block to
 * surface the caught error. A log call that records only a message drops the
 * cause and makes the failure undiagnosable, so this rule reports a log call
 * inside a catch block whose arguments reference neither the caught error nor
 * a value derived from it.
 *
 * What counts as surfacing the error:
 * - Referencing the caught binding itself, or a variable whose value —
 *   declared or assigned inside the catch block before the log call —
 *   derives from the binding directly or through other derived variables
 *   (derivations are tracked transitively, so extracting the message and
 *   then sanitizing it still counts). A variable's name alone never counts:
 *   a local called `errorMessage` that was built from a static string does
 *   not surface anything.
 * - A nested catch block is judged against its own binding. The outer catch
 *   does not claim the inner handler's log calls, and the inner handler does
 *   not inherit the outer binding.
 *
 * Out of scope:
 * - Silent catch blocks (no log call): continuing without the error is a
 *   deliberate, visible choice there, while logging without the error looks
 *   diagnosed but is not.
 * - A log call that is a direct statement of the catch block, followed in
 *   the same block by an unconditional return or throw that hands the error
 *   (or a value derived from it) to the caller: on the path that logs, the
 *   error still reaches the caller through the exit. A conditional exit
 *   does not exempt log calls on the paths that do not take it.
 *
 * A failure whose error must not be logged at all (for example a git error
 * that can contain the source repository path or credentials) stays an
 * explicit, per-site exception through an eslint-disable comment with the
 * reason, so the gate itself has no silent holes.
 */

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);

function isLogCall(node) {
  return node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object.type === 'Identifier'
    && node.callee.object.name === 'log'
    && node.callee.property.type === 'Identifier'
    && LOG_METHODS.has(node.callee.property.name);
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression';
}

/** Nested functions and nested catch blocks form their own scope. */
function isBoundaryNode(node) {
  return isFunctionNode(node) || node.type === 'CatchClause';
}

function eachChild(node, callback) {
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') callback(child);
      }
    } else if (value && typeof value.type === 'string') {
      callback(value);
    }
  }
}

/**
 * Collect log calls governed by this catch block, without entering nested
 * functions or a nested catch block (the nested handler is visited on its
 * own, against its own binding).
 */
function collectLogCalls(node, out) {
  if (isBoundaryNode(node)) return;
  if (isLogCall(node)) out.push(node);
  eachChild(node, (child) => collectLogCalls(child, out));
}

/**
 * Collect identifier names referenced by a node. Object literal keys are not
 * references, so `{ error: 'static' }` does not count as surfacing an error.
 */
function collectReferencedNames(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') {
    out.add(node.name);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') collectReferencedNames(child, out);
      }
    } else if (value && typeof value.type === 'string') {
      if (node.type === 'Property' && key === 'key' && !node.computed) continue;
      if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
      collectReferencedNames(value, out);
    }
  }
}

/**
 * Value-producing facts inside the catch block, in its own scope only:
 * variable declarations with an initializer and assignments to a plain
 * identifier, each with the source position of the produced value.
 */
function collectFlowFacts(node, out) {
  if (!node || typeof node.type !== 'string' || isBoundaryNode(node)) return;
  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      if (declaration.id && declaration.id.type === 'Identifier' && declaration.init) {
        out.push({
          name: declaration.id.name,
          value: declaration.init,
          position: declaration.init.range?.[0] ?? 0,
        });
      }
    }
  }
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
    out.push({
      name: node.left.name,
      value: node.right,
      position: node.right.range?.[0] ?? 0,
    });
  }
  eachChild(node, (child) => collectFlowFacts(child, out));
}

/**
 * Names of variables whose value, produced before `beforePosition`, derives
 * from one of the seed names, directly or through other derived variables
 * (e.g. `const message = getErrorMessage(err)` then `const safe = sanitize(message)`,
 * or `lastError = error.message` assigned from the binding). Logging or
 * returning such a derived value surfaces the caught error. A value produced
 * after the log call cannot have been logged by it, so later facts do not
 * count for that call.
 */
function collectDerivedNames(facts, seedNames, beforePosition) {
  const derived = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fact of facts) {
      if (fact.position >= beforePosition || derived.has(fact.name)) continue;
      const referenced = new Set();
      collectReferencedNames(fact.value, referenced);
      if ([...referenced].some((name) => seedNames.has(name) || derived.has(name))) {
        derived.add(fact.name);
        changed = true;
      }
    }
  }
  return derived;
}

function referencesSurfacedError(referenced, paramName, derivedNames) {
  return [...referenced].some((name) =>
    (paramName !== null && name === paramName)
    || derivedNames.has(name));
}

/** A return or throw whose value carries the caught error to the caller. */
function isPropagatingExit(statement, paramName, derivedNames) {
  if (statement.type !== 'ReturnStatement' && statement.type !== 'ThrowStatement') return false;
  if (!statement.argument) return false;
  const referenced = new Set();
  collectReferencedNames(statement.argument, referenced);
  return referencesSurfacedError(referenced, paramName, derivedNames);
}

/**
 * A log call is exempt when it is a direct statement of the catch block and
 * an unconditional propagating exit follows it in the same block: executing
 * the log call on that straight-line path necessarily reaches the exit, so
 * the error reaches the caller there. Log calls nested in a conditional or
 * loop are never exempt, and a conditional exit exempts nothing.
 */
function isExemptLogCall(block, logCall, paramName, seedNames, facts) {
  const statements = block.body ?? [];
  const index = statements.findIndex(
    (statement) => statement.type === 'ExpressionStatement' && statement.expression === logCall,
  );
  if (index === -1) return false;
  return statements.slice(index + 1).some((statement) => {
    const derivedNames = collectDerivedNames(
      facts,
      seedNames,
      statement.range?.[0] ?? Number.POSITIVE_INFINITY,
    );
    return isPropagatingExit(statement, paramName, derivedNames);
  });
}

const catchLogIncludesError = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a log call inside a catch block to include the caught error',
    },
    messages: {
      missingError: 'Log the caught error: include the error in the log context (for example { error: getErrorMessage(err) }) so the failure stays diagnosable.',
    },
    schema: [],
  },
  create(context) {
    return {
      CatchClause(node) {
        const logCalls = [];
        collectLogCalls(node.body, logCalls);
        if (logCalls.length === 0) return;

        const paramName = node.param && node.param.type === 'Identifier' ? node.param.name : null;
        const seedNames = new Set(paramName ? [paramName] : []);
        const facts = [];
        collectFlowFacts(node.body, facts);

        for (const logCall of logCalls) {
          const derivedNames = collectDerivedNames(
            facts,
            seedNames,
            logCall.range?.[0] ?? Number.POSITIVE_INFINITY,
          );
          const referenced = new Set();
          for (const argument of logCall.arguments) {
            collectReferencedNames(argument, referenced);
          }
          if (referencesSurfacedError(referenced, paramName, derivedNames)) continue;
          if (isExemptLogCall(node.body, logCall, paramName, seedNames, facts)) continue;
          context.report({ node: logCall, messageId: 'missingError' });
        }
      },
    };
  },
};

/** The plugin object registers the rule under the `takt` namespace. */
export const catchLintPlugin = {
  rules: {
    'catch-log-includes-error': catchLogIncludesError,
  },
};

/** 同じ規則を 通常 ESLint の override と規則テストが使う。 */
export const catchRules = {
  'takt/catch-log-includes-error': 'error',
};
