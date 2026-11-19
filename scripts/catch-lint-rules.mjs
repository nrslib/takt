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
 * - Referencing the caught binding itself, or a variable whose current value
 *   derives from the binding. Derivations are tracked per variable binding
 *   (not per name, so a shadowed variable in a nested block is a different
 *   variable) and in execution order: a value copied before its source became
 *   derived does not count, and overwriting a derived variable with an
 *   unrelated value ends its derivation. Derivations are transitive, so
 *   extracting the message and then sanitizing it still counts. A variable's
 *   name alone never counts: a local called `errorMessage` that was built
 *   from a static string does not surface anything.
 * - A value assigned only inside a conditional branch counts only for log
 *   calls that the same branch guarantees: on a path that skips the branch,
 *   the variable still holds its earlier value.
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
 *   (or a value derived from it) to the caller, with no intervening exit
 *   that drops the error: on every path that logs, the error still reaches
 *   the caller. A conditional exit that returns or throws something else
 *   breaks the exemption for the paths that take it.
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
 * Map every identifier that declares or references a variable to that
 * variable, using ESLint's scope analysis. Identifiers the analysis cannot
 * resolve fall back to a name key, which keeps the previous name-based
 * behavior for them.
 */
function buildVariableMap(sourceCode) {
  const map = new Map();
  const scopeManager = sourceCode.scopeManager;
  if (!scopeManager) return map;
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const definition of variable.defs) {
        if (definition.name) map.set(definition.name, variable);
      }
      for (const identifier of variable.identifiers) map.set(identifier, variable);
      for (const reference of variable.references) map.set(reference.identifier, variable);
    }
  }
  return map;
}

/**
 * Collect the variable keys referenced by a node. Object literal keys are
 * not references, so `{ error: 'static' }` does not count as surfacing an
 * error.
 */
function collectReferencedKeys(node, keyOf, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') {
    out.add(keyOf(node));
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') collectReferencedKeys(child, keyOf, out);
      }
    } else if (value && typeof value.type === 'string') {
      if (node.type === 'Property' && key === 'key' && !node.computed) continue;
      if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
      collectReferencedKeys(value, keyOf, out);
    }
  }
}

/**
 * Walk a catch block in its own scope, recording value-producing facts,
 * log calls, and exits, each with the chain of conditional branches that
 * guards it. A guard entry is the branch node that was descended into, so
 * the two branches of one `if` are different guards. Nested functions and
 * nested catch blocks are boundaries and are not entered.
 */
function collectFlow(node, guards, sink) {
  if (!node || typeof node.type !== 'string' || isBoundaryNode(node)) return;
  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      if (declaration.id && declaration.id.type === 'Identifier' && declaration.init) {
        sink.facts.push({
          key: sink.keyOf(declaration.id),
          value: declaration.init,
          position: declaration.init.range?.[0] ?? 0,
          guards,
        });
      }
    }
  }
  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
    sink.facts.push({
      key: sink.keyOf(node.left),
      value: node.right,
      position: node.right.range?.[0] ?? 0,
      guards,
    });
  }
  if (isLogCall(node)) sink.logCalls.push({ node, guards });
  if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
    sink.exits.push({ node, guards });
  }
  const descend = (child, childGuards) => collectFlow(child, childGuards, sink);
  switch (node.type) {
    case 'IfStatement':
      descend(node.test, guards);
      descend(node.consequent, [...guards, node.consequent]);
      if (node.alternate) descend(node.alternate, [...guards, node.alternate]);
      return;
    case 'ConditionalExpression':
      descend(node.test, guards);
      descend(node.consequent, [...guards, node.consequent]);
      descend(node.alternate, [...guards, node.alternate]);
      return;
    case 'LogicalExpression':
      descend(node.left, guards);
      descend(node.right, [...guards, node.right]);
      return;
    case 'ForStatement':
      if (node.init) descend(node.init, guards);
      if (node.test) descend(node.test, guards);
      if (node.update) descend(node.update, guards);
      descend(node.body, [...guards, node.body]);
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      descend(node.right, guards);
      descend(node.body, [...guards, node.body]);
      return;
    case 'WhileStatement':
      descend(node.test, guards);
      descend(node.body, [...guards, node.body]);
      return;
    case 'DoWhileStatement':
      descend(node.body, guards);
      descend(node.test, guards);
      return;
    case 'TryStatement':
      descend(node.block, [...guards, node.block]);
      // The handler is a nested CatchClause (a boundary, judged on its own).
      if (node.finalizer) descend(node.finalizer, guards);
      return;
    case 'SwitchStatement':
      descend(node.discriminant, guards);
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) descend(statement, [...guards, switchCase]);
      }
      return;
    default:
      eachChild(node, (child) => descend(child, guards));
  }
}

function isGuardPrefix(factGuards, targetGuards) {
  return factGuards.length <= targetGuards.length
    && factGuards.every((guard, index) => guard === targetGuards[index]);
}

/**
 * Keys of variables whose value, at `beforePosition` on the paths described
 * by `guards`, derives from the seed key. Facts are applied in source order:
 * a write whose value references the seed or a currently derived variable
 * makes its target derived, and any other write to a variable ends that
 * variable's derivation, because the logged value is the latest one. Facts
 * guarded by a branch that does not guard the target do not apply, and a
 * value produced after the target cannot have reached it.
 */
function collectDerivedKeys(facts, keyOf, seedKey, beforePosition, guards) {
  const derived = new Set();
  if (seedKey === null) return derived;
  const applicable = facts
    .filter((fact) => fact.position < beforePosition && isGuardPrefix(fact.guards, guards))
    .sort((left, right) => left.position - right.position);
  for (const fact of applicable) {
    const referenced = new Set();
    collectReferencedKeys(fact.value, keyOf, referenced);
    if ([...referenced].some((key) => key === seedKey || derived.has(key))) {
      derived.add(fact.key);
    } else {
      derived.delete(fact.key);
    }
  }
  return derived;
}

function referencesSurfacedError(referenced, seedKey, derivedKeys) {
  return [...referenced].some((key) => key === seedKey || derivedKeys.has(key));
}

/** A return or throw whose value carries the caught error to the caller. */
function isPropagatingExit(exitNode, keyOf, seedKey, derivedKeys) {
  if (!exitNode.argument) return false;
  const referenced = new Set();
  collectReferencedKeys(exitNode.argument, keyOf, referenced);
  return referencesSurfacedError(referenced, seedKey, derivedKeys);
}

/**
 * A log call is exempt when it is a direct statement of the catch block and
 * the first unconditional exit that follows it in the same block hands the
 * error to the caller, and no exit between the log call and that exit drops
 * the error on a path of its own. Log calls nested in a conditional or loop
 * are never exempt, and a conditional exit that propagates the error does
 * not exempt anything by itself.
 */
function isExemptLogCall(block, logCall, flow, seedKey) {
  const statements = block.body ?? [];
  const index = statements.findIndex(
    (statement) => statement.type === 'ExpressionStatement' && statement.expression === logCall.node,
  );
  if (index === -1) return false;
  for (let next = index + 1; next < statements.length; next++) {
    const statement = statements[next];
    if (statement.type !== 'ReturnStatement' && statement.type !== 'ThrowStatement') continue;
    const derivedAtExit = collectDerivedKeys(flow.facts, flow.keyOf, seedKey, statement.range?.[0] ?? 0, []);
    if (!isPropagatingExit(statement, flow.keyOf, seedKey, derivedAtExit)) return false;
    const logPosition = logCall.node.range?.[0] ?? 0;
    const exitPosition = statement.range?.[0] ?? Number.POSITIVE_INFINITY;
    for (const exit of flow.exits) {
      const position = exit.node.range?.[0] ?? 0;
      if (position <= logPosition || position >= exitPosition) continue;
      const derivedAtNested = collectDerivedKeys(flow.facts, flow.keyOf, seedKey, position, exit.guards);
      if (!isPropagatingExit(exit.node, flow.keyOf, seedKey, derivedAtNested)) return false;
    }
    return true;
  }
  return false;
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
    let variableMap;
    const keyOf = (identifier) => {
      variableMap ??= buildVariableMap(context.sourceCode);
      return variableMap.get(identifier) ?? `name:${identifier.name}`;
    };
    return {
      CatchClause(node) {
        const flow = { facts: [], logCalls: [], exits: [], keyOf };
        collectFlow(node.body, [], flow);
        if (flow.logCalls.length === 0) return;

        const seedKey = node.param && node.param.type === 'Identifier' ? keyOf(node.param) : null;

        for (const logCall of flow.logCalls) {
          const derivedKeys = collectDerivedKeys(
            flow.facts,
            keyOf,
            seedKey,
            logCall.node.range?.[0] ?? Number.POSITIVE_INFINITY,
            logCall.guards,
          );
          const referenced = new Set();
          for (const argument of logCall.node.arguments) {
            collectReferencedKeys(argument, keyOf, referenced);
          }
          if (referencesSurfacedError(referenced, seedKey, derivedKeys)) continue;
          if (isExemptLogCall(node.body, logCall, flow, seedKey)) continue;
          context.report({ node: logCall.node, messageId: 'missingError' });
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
