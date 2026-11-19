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
 *   the variable still holds its earlier value. The dual also holds: a
 *   conditional overwrite with an unrelated value ends the derivation for
 *   later log calls, because the overwriting path may have been taken.
 *   An if/else that writes a variable in both branches joins the writes:
 *   after the statement the variable counts as derived only when both
 *   branches' latest values are.
 * - The caught binding itself is tracked like any other variable: it
 *   starts out derived, and overwriting it with an unrelated value ends
 *   that. A conditional nested anywhere inside a value — for example in a
 *   log call's metadata object — must carry the error on every branch,
 *   not just when the conditional is the whole value.
 * - Guard chains exclude each other only where they take different
 *   branches of the same construct. A write inside one `if` still applies
 *   to a log call inside a later, unrelated `if`, because the first
 *   branch may have run before the second was reached.
 * - A logical assignment (`&&=`, `||=`, `??=`) replaces the value on the
 *   path that takes the right-hand side, so it keeps a derivation only
 *   when both the previous value and the right-hand side are derived.
 *   Destructuring takes each binding's value from its own position: a
 *   binding fed by a different element or property of a literal does not
 *   inherit that literal's other parts.
 * - A nested catch handler's log calls are judged against the handler's
 *   own binding, but its writes still count for the outer block: a write
 *   that replaces an outer variable inside the handler can end that
 *   variable's derivation for later outer log calls, and a value the
 *   handler throws is judged with the handler's own writes in scope. A
 *   `break` or `continue` whose target lies outside the catch block is
 *   an exit that does not hand the error to the caller.
 * - An array rest binding takes every element from its own position
 *   onward, so it carries the error when any remaining element does. A
 *   branch join evaluates each branch's latest write against the state
 *   at that write, not at the branch's end: a value copied before its
 *   source was overwritten keeps the derivation it had when copied.
 *   A write inside a try block may reach that block's handler, because
 *   the handler runs after the part of the block that executed. A write
 *   later in a loop body reaches a log call earlier in the body on the
 *   next iteration, so it can end a derivation there, though it cannot
 *   establish one the first iteration would not have had.
 * - A compound assignment (`+=` and friends) keeps the previous value as
 *   part of the result, so it preserves a derivation the previous value
 *   had. A binding introduced by destructuring a derived value (for
 *   example `const { message } = err`) is itself derived. A conditional
 *   or logical expression counts as derived only when every branch that
 *   can produce its value is derived. An assignment in a loop's update
 *   expression runs after the body, so it never establishes the value a
 *   log call inside the body sees.
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
 *   breaks the exemption for the paths that take it, and so does an exit
 *   inside a nested catch handler between the log call and that exit: the
 *   nested handler runs on its own failure path and can leave the function
 *   without the outer error.
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
 * The bindings a declaration or assignment pattern introduces, each with
 * the expression that feeds it. A binding fed from a literal takes its
 * own element or property of that literal, not the whole literal; any
 * other source feeds every binding from the whole expression (a property
 * of a derived value is itself derived). A default value applies when
 * the extracted value is undefined, so a binding with a default is fed
 * by either the source or the default. A binding for an element or
 * property a literal does not have is fed by nothing (null).
 */
function collectBindingSources(pattern, source, out) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.push({ identifier: pattern, value: source });
      return;
    case 'RestElement':
      collectBindingSources(pattern.argument, source, out);
      return;
    case 'AssignmentPattern': {
      const value = source === null || source === undefined
        ? pattern.right
        : source.type === 'Literal'
          ? source
          : { type: 'ConditionalExpression', consequent: source, alternate: pattern.right };
      collectBindingSources(pattern.left, value, out);
      return;
    }
    case 'ObjectPattern': {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          collectBindingSources(property.argument, source, out);
          continue;
        }
        let propertySource = source;
        if (source && source.type === 'ObjectExpression') {
          const keyName = property.key && property.key.type === 'Identifier' && !property.computed
            ? property.key.name
            : property.key && property.key.type === 'Literal'
              ? String(property.key.value)
              : null;
          const match = keyName === null
            ? undefined
            : source.properties.find((candidate) => candidate.type !== 'SpreadElement'
              && !candidate.computed
              && ((candidate.key.type === 'Identifier' && candidate.key.name === keyName)
                || (candidate.key.type === 'Literal' && String(candidate.key.value) === keyName)));
          const hasSpread = source.properties.some((candidate) => candidate.type === 'SpreadElement');
          propertySource = match ? match.value : hasSpread || keyName === null ? source : null;
        }
        collectBindingSources(property.value, propertySource, out);
      }
      return;
    }
    case 'ArrayPattern': {
      pattern.elements.forEach((element, index) => {
        if (!element) return;
        let elementSource = source;
        if (source && source.type === 'ArrayExpression') {
          // A rest binding receives every remaining element, not only
          // the one at its own position.
          elementSource = element.type === 'RestElement'
            ? { type: 'ArrayExpression', elements: source.elements.slice(index) }
            : source.elements[index] ?? null;
        }
        collectBindingSources(element, elementSource, out);
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Whether a break or continue lands on a loop, switch, or label inside
 * the block being walked. A jump whose target lies outside the block
 * leaves the block without handing the caught error to the caller, so
 * the caller records it as an exit.
 */
function isInternalJump(node, targets) {
  const label = node.label?.name;
  if (label !== undefined && label !== null) {
    return targets.some((target) => target.type === 'LabeledStatement' && target.label?.name === label);
  }
  if (node.type === 'BreakStatement') return targets.length > 0;
  return targets.some((target) => target.type === 'ForStatement'
    || target.type === 'ForInStatement'
    || target.type === 'ForOfStatement'
    || target.type === 'WhileStatement'
    || target.type === 'DoWhileStatement');
}

/**
 * Walk a catch block in its own scope, recording value-producing facts,
 * log calls, and exits, each with the chain of conditional branches that
 * guards it. A guard entry is the branch node that was descended into, so
 * the two branches of one `if` are different guards. Nested functions and
 * nested catch blocks are boundaries and are not entered.
 */
/**
 * After an if/else, a variable written in both branches holds one of the
 * two branches' latest values. The join is recorded only for writes that
 * run unconditionally within their branch (their guard chain is exactly
 * the branch itself): a write nested in a further conditional inside the
 * branch does not decide the branch's end state. The recorded value is a
 * BranchJoin, which the evaluation resolves against the state at
 * each branch's own latest write, so a variable derived from a
 * branch-local alias still counts, and a value copied before its
 * source was overwritten keeps the derivation it had when copied. A compound write keeps the value the variable had before its
 * branch (the CompoundValue wrapper); a logical assignment keeps it only
 * on the path that skips the right-hand side (a conditional between the
 * right-hand side and a SelfValue).
 */
function joinBranchWrites(ifNode, consequentFacts, alternateFacts, guards, sink, mode) {
  const latestByKey = (facts, branchNode) => {
    const expected = [...guards, branchNode];
    const byKey = new Map();
    for (const fact of facts) {
      const unconditional = fact.guards.length === expected.length
        && fact.guards.every((guard, index) => guard === expected[index]);
      if (unconditional) byKey.set(fact.key, fact);
    }
    return byKey;
  };
  const consequentLatest = latestByKey(consequentFacts, ifNode.consequent);
  const alternateLatest = latestByKey(alternateFacts, ifNode.alternate);
  for (const [key, consequentFact] of consequentLatest) {
    const alternateFact = alternateLatest.get(key);
    if (!alternateFact) continue;
    const branchValue = (fact) => {
      if (fact.shortCircuits) {
        return {
          type: 'ConditionalExpression',
          consequent: fact.value,
          alternate: { type: 'SelfValue', key: fact.key },
        };
      }
      return fact.includesSelf
        ? { type: 'CompoundValue', value: fact.value, key: fact.key }
        : fact.value;
    };
    const branch = (fact, branchNode) => ({
      value: branchValue(fact),
      guards: [...guards, branchNode],
      at: fact.position,
    });
    sink.facts.push({
      key,
      value: {
        type: 'BranchJoin',
        branches: [branch(consequentFact, ifNode.consequent), branch(alternateFact, ifNode.alternate)],
      },
      position: ifNode.range?.[1] ?? 0,
      guards,
      mayOnly: mode.mayOnly === true,
      includesSelf: false,
      shortCircuits: false,
    });
  }
}

function collectFlow(node, guards, sink, mode = {}) {
  if (!node || typeof node.type !== 'string' || isBoundaryNode(node)) return;
  if ((node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'
    || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') && node.body) {
    // Loop bodies are recorded so the evaluation can tell that a write
    // later in the body reaches an earlier log call on the next pass.
    (sink.facts.loopBodies ??= []).push(node.body);
  }
  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      if (!declaration.init) continue;
      const bound = [];
      collectBindingSources(declaration.id, declaration.init, bound);
      for (const binding of bound) {
        sink.facts.push({
          key: sink.keyOf(binding.identifier),
          value: binding.value,
          position: declaration.init.range?.[0] ?? 0,
          guards,
          mayOnly: mode.mayOnly === true,
          includesSelf: false,
          shortCircuits: false,
        });
      }
    }
  }
  if (node.type === 'AssignmentExpression') {
    if (node.left.type === 'Identifier') {
      const shortCircuits = node.operator === '&&=' || node.operator === '||=' || node.operator === '??=';
      sink.facts.push({
        key: sink.keyOf(node.left),
        value: node.right,
        position: node.right.range?.[0] ?? 0,
        guards,
        mayOnly: mode.mayOnly === true,
        includesSelf: node.operator !== '=' && !shortCircuits,
        shortCircuits,
      });
    } else if (node.operator === '=') {
      const bound = [];
      collectBindingSources(node.left, node.right, bound);
      for (const binding of bound) {
        sink.facts.push({
          key: sink.keyOf(binding.identifier),
          value: binding.value,
          position: node.right.range?.[0] ?? 0,
          guards,
          mayOnly: mode.mayOnly === true,
          includesSelf: false,
          shortCircuits: false,
        });
      }
    }
  }
  if (!mode.exitsOnly && isLogCall(node)) sink.logCalls.push({ node, guards });
  if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
    sink.exits.push({ node, guards });
  }
  if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
    if (!isInternalJump(node, mode.targets ?? [])) sink.exits.push({ node, guards });
    return;
  }
  const descend = (child, childGuards, childMode = mode) => collectFlow(child, childGuards, sink, childMode);
  switch (node.type) {
    case 'IfStatement': {
      descend(node.test, guards);
      const consequentStart = sink.facts.length;
      descend(node.consequent, [...guards, node.consequent]);
      if (!node.alternate) return;
      const consequentFacts = sink.facts.slice(consequentStart);
      const alternateStart = sink.facts.length;
      descend(node.alternate, [...guards, node.alternate]);
      const alternateFacts = sink.facts.slice(alternateStart);
      joinBranchWrites(node, consequentFacts, alternateFacts, guards, sink, mode);
      return;
    }
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
      if (node.update) descend(node.update, guards, { ...mode, mayOnly: true });
      descend(node.body, [...guards, node.body], { ...mode, targets: [...(mode.targets ?? []), node] });
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      descend(node.right, guards);
      descend(node.body, [...guards, node.body], { ...mode, targets: [...(mode.targets ?? []), node] });
      return;
    case 'WhileStatement':
      descend(node.test, guards);
      descend(node.body, [...guards, node.body], { ...mode, targets: [...(mode.targets ?? []), node] });
      return;
    case 'DoWhileStatement':
      descend(node.body, guards, { ...mode, targets: [...(mode.targets ?? []), node] });
      descend(node.test, guards);
      return;
    case 'LabeledStatement':
      descend(node.body, guards, { ...mode, targets: [...(mode.targets ?? []), node] });
      return;
    case 'TryStatement':
      descend(node.block, [...guards, node.block]);
      // The nested handler is judged on its own when its CatchClause is
      // visited, but its exits can leave this function without the error
      // caught here, and its writes can replace what an outer variable
      // holds, so the outer analysis collects both its exits and its
      // facts. Its log calls are not collected: they belong to the
      // handler's own binding.
      if (node.handler) {
        collectFlow(node.handler.body, [...guards, node.handler], sink, { ...mode, exitsOnly: true });
      }
      if (node.finalizer) descend(node.finalizer, guards);
      return;
    case 'SwitchStatement':
      descend(node.discriminant, guards);
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) {
          descend(statement, [...guards, switchCase], { ...mode, targets: [...(mode.targets ?? []), node] });
        }
      }
      return;
    default:
      eachChild(node, (child) => descend(child, guards));
  }
}

/**
 * Whether an expression's value carries the caught error on every path
 * that can produce it. A conditional or logical expression yields one of
 * its branches, so every branch must carry the error, wherever the
 * conditional sits inside the value — at the top level, inside a log
 * call's metadata object, or inside a call argument. Any other expression
 * carries the error when one of its value positions does: an object
 * through a property value, a call through an argument, a member access
 * through its object. A synthetic CompoundValue node stands for a
 * compound assignment's result, which keeps the variable's previous
 * value next to the assigned one.
 */
function isDerivedValue(node, keyOf, seedKey, derivedKeys, facts) {
  if (!node) return false;
  if (node.type === 'ConditionalExpression') {
    return isDerivedValue(node.consequent, keyOf, seedKey, derivedKeys, facts)
      && isDerivedValue(node.alternate, keyOf, seedKey, derivedKeys, facts);
  }
  if (node.type === 'LogicalExpression') {
    return isDerivedValue(node.left, keyOf, seedKey, derivedKeys, facts)
      && isDerivedValue(node.right, keyOf, seedKey, derivedKeys, facts);
  }
  if (node.type === 'CompoundValue') {
    return isDerivedValue(node.value, keyOf, seedKey, derivedKeys, facts) || derivedKeys.has(node.key);
  }
  if (node.type === 'SelfValue') return derivedKeys.has(node.key);
  if (node.type === 'BranchJoin') {
    return node.branches.every((branch) => {
      const branchKeys = collectDerivedKeys(facts, keyOf, seedKey, branch.at, branch.guards);
      return isDerivedValue(branch.value, keyOf, seedKey, branchKeys, facts);
    });
  }
  if (node.type === 'Identifier') return derivedKeys.has(keyOf(node));
  return expressionChildren(node).some(
    (child) => isDerivedValue(child, keyOf, seedKey, derivedKeys, facts),
  );
}

/** The sub-expressions that feed a node's value (keys and callees aside). */
function expressionChildren(node) {
  switch (node.type) {
    case 'ObjectExpression':
      return node.properties.flatMap((property) => {
        if (property.type === 'SpreadElement') return [property.argument];
        return [...(property.computed ? [property.key] : []), property.value];
      });
    case 'ArrayExpression':
      return node.elements.filter((element) => element !== null);
    case 'CallExpression':
    case 'NewExpression':
      return [...(node.callee.type === 'MemberExpression' ? [node.callee] : []), ...node.arguments];
    case 'MemberExpression':
      return node.computed ? [node.object, node.property] : [node.object];
    case 'TemplateLiteral':
      return node.expressions;
    case 'TaggedTemplateExpression':
      return node.quasi.expressions;
    case 'UnaryExpression':
    case 'AwaitExpression':
    case 'SpreadElement':
      return [node.argument];
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return [node.expression];
    case 'BinaryExpression':
      return [node.left, node.right];
    case 'SequenceExpression':
      return node.expressions;
    case 'AssignmentExpression':
      return [node.right];
    case 'ChainExpression':
      return [node.expression];
    default:
      return [];
  }
}

function isGuardPrefix(factGuards, targetGuards) {
  return factGuards.length <= targetGuards.length
    && factGuards.every((guard, index) => guard === targetGuards[index]);
}

/**
 * Keys of variables whose value, at `beforePosition` on the paths described
 * by `guards`, derives from the seed key. Facts are applied in source order.
 * A write guarded by a branch that cannot reach the target does not apply,
 * and a value produced after the target cannot have reached it.
 */
function guardsCompatible(factGuards, targetGuards) {
  const shared = Math.min(factGuards.length, targetGuards.length);
  for (let index = 0; index < shared; index++) {
    if (factGuards[index] === targetGuards[index]) continue;
    // Two guard entries exclude each other only when they are branches
    // of the same construct (an if and its else, two cases of one
    // switch): those paths cannot both run. Branches of unrelated
    // constructs can both run, so a write under one may still have
    // happened on the way to the other. A try block and its handler
    // are not alternatives either: the handler runs after the part of
    // the block that executed, so a write in the block may have
    // happened on the way into the handler.
    const factParent = factGuards[index].parent;
    if (factParent && factParent === targetGuards[index].parent) {
      if (factParent.type === 'TryStatement'
        && factGuards[index] === factParent.block
        && targetGuards[index] === factParent.handler) continue;
      return false;
    }
  }
  return true;
}

const derivedKeysCache = new WeakMap();

function collectDerivedKeys(facts, keyOf, seedKey, beforePosition, guards) {
  if (seedKey === null) return new Set();
  // Resolving a branch join re-enters this function for each branch, and
  // sequential joins would otherwise replay every earlier join for each
  // later one. The result depends only on the facts, the position, and
  // the guard chain, so memoize it per facts array.
  let cache = derivedKeysCache.get(facts);
  if (!cache) {
    cache = new Map();
    derivedKeysCache.set(facts, cache);
  }
  const cacheKey = `${beforePosition}#${guards.map((guard) => `${guard.type}@${guard.range?.[0]}:${guard.range?.[1]}`).join('|')}`;
  const cached = cache.get(cacheKey);
  if (cached) return new Set(cached);
  const derived = computeDerivedKeys(facts, keyOf, seedKey, beforePosition, guards);
  cache.set(cacheKey, new Set(derived));
  return derived;
}

function computeDerivedKeys(facts, keyOf, seedKey, beforePosition, guards) {
  // The caught binding starts out derived; a write that replaces it with
  // an unrelated value ends that, like a write to any other variable.
  const derived = new Set([seedKey]);
  // A write later in the same loop body reaches a log call earlier in
  // the body on the next iteration. Such a write applies as a possible
  // (never deciding) fact, ordered as if it ran at the body's start:
  // the previous iteration's writes precede this iteration's.
  const loopBodies = (facts.loopBodies ?? []).filter((body) => {
    const range = body.range ?? [];
    return (range[0] ?? 0) <= beforePosition && beforePosition <= (range[1] ?? 0);
  });
  const innermostLoop = loopBodies.sort((left, right) => (right.range?.[0] ?? 0) - (left.range?.[0] ?? 0))[0];
  const applicable = [];
  for (const fact of facts) {
    if (fact.position < beforePosition) {
      applicable.push({ fact, effective: fact.position, backEdge: false });
    } else if (innermostLoop && guardsCompatible(fact.guards, guards)) {
      const range = innermostLoop.range ?? [];
      if ((range[0] ?? 0) <= fact.position && fact.position <= (range[1] ?? 0)) {
        applicable.push({ fact, effective: range[0] ?? 0, backEdge: true });
      }
    }
  }
  applicable.sort((left, right) => left.effective - right.effective);
  for (const { fact, backEdge } of applicable) {
    // A write on every path to the target (its guards are a prefix of the
    // target's) decides the value there. A write that only may have run —
    // inside a branch the target is not in, or in a loop update — cannot
    // establish a derivation, but an unrelated value there still ends one,
    // because the target may be reached through that write.
    const must = !backEdge && fact.mayOnly !== true && isGuardPrefix(fact.guards, guards);
    const may = !must && guardsCompatible(fact.guards, guards);
    if (!must && !may) continue;
    const valueDerived = fact.shortCircuits
      ? derived.has(fact.key) && isDerivedValue(fact.value, keyOf, seedKey, derived, facts)
      : isDerivedValue(fact.value, keyOf, seedKey, derived, facts)
        || (fact.includesSelf && derived.has(fact.key));
    if (valueDerived) {
      if (must) derived.add(fact.key);
    } else {
      derived.delete(fact.key);
    }
  }
  return derived;
}

/** A return or throw whose value carries the caught error to the caller. */
function isPropagatingExit(exitNode, keyOf, seedKey, derivedKeys, facts) {
  if (!exitNode.argument) return false;
  return isDerivedValue(exitNode.argument, keyOf, seedKey, derivedKeys, facts);
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
    if (!isPropagatingExit(statement, flow.keyOf, seedKey, derivedAtExit, flow.facts)) return false;
    const logPosition = logCall.node.range?.[0] ?? 0;
    const exitPosition = statement.range?.[0] ?? Number.POSITIVE_INFINITY;
    for (const exit of flow.exits) {
      const position = exit.node.range?.[0] ?? 0;
      if (position <= logPosition || position >= exitPosition) continue;
      const derivedAtNested = collectDerivedKeys(flow.facts, flow.keyOf, seedKey, position, exit.guards);
      if (!isPropagatingExit(exit.node, flow.keyOf, seedKey, derivedAtNested, flow.facts)) return false;
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
          const surfaces = logCall.node.arguments.some(
            (argument) => isDerivedValue(argument, keyOf, seedKey, derivedKeys, flow.facts),
          );
          if (surfaces) continue;
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
