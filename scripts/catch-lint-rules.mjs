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
 * Out of scope:
 * - Silent catch blocks (no log call) and catch blocks that rethrow:
 *   continuing without the error is a deliberate, visible choice there, while
 *   logging without the error looks diagnosed but is not.
 * - Catch blocks that return the error (or a value derived from it) to the
 *   caller: the failure is surfaced through the result instead of the log.
 *
 * A failure whose error must not be logged at all (for example a git error
 * that can contain the source repository path or credentials) stays an
 * explicit, per-site exception through an eslint-disable comment with the
 * reason, so the gate itself has no silent holes.
 */

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);
const ERROR_NAME_PATTERN = /error/i;

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

/** Collect log calls in a catch block, without entering nested functions. */
function collectLogCalls(node, out) {
  if (isFunctionNode(node)) return;
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
 * Names of variables declared directly in the catch block whose initializer
 * references one of the seed names (e.g. `const msg = getErrorMessage(err)`).
 * Logging or returning such a derived value surfaces the caught error.
 */
function collectDerivedNames(block, seedNames) {
  const derived = new Set();
  const statements = block.body ?? [];
  for (const statement of statements) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (!declaration.init || declaration.id.type !== 'Identifier') continue;
      const referenced = new Set();
      collectReferencedNames(declaration.init, referenced);
      if ([...referenced].some((name) => seedNames.has(name))) {
        derived.add(declaration.id.name);
      }
    }
  }
  return derived;
}

function referencesSurfacedError(referenced, paramName, derivedNames) {
  return [...referenced].some((name) =>
    (paramName !== null && name === paramName)
    || derivedNames.has(name)
    || ERROR_NAME_PATTERN.test(name));
}

/** True when a return in the catch block hands the error to the caller. */
function returnsSurfacedError(node, paramName, derivedNames) {
  if (isFunctionNode(node)) return false;
  if (node.type === 'ReturnStatement' && node.argument) {
    const referenced = new Set();
    collectReferencedNames(node.argument, referenced);
    if (referencesSurfacedError(referenced, paramName, derivedNames)) return true;
  }
  let surfaced = false;
  eachChild(node, (child) => {
    if (!surfaced && returnsSurfacedError(child, paramName, derivedNames)) {
      surfaced = true;
    }
  });
  return surfaced;
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
        const derivedNames = collectDerivedNames(node.body, seedNames);

        if (returnsSurfacedError(node.body, paramName, derivedNames)) return;

        for (const logCall of logCalls) {
          const referenced = new Set();
          for (const argument of logCall.arguments) {
            collectReferencedNames(argument, referenced);
          }
          if (!referencesSurfacedError(referenced, paramName, derivedNames)) {
            context.report({ node: logCall, messageId: 'missingError' });
          }
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
