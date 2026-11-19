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

const catchLogIncludesError = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Report direct catch logs when the caught error is never read',
    },
    messages: {
      missingError: 'This catch logs a failure without reading the caught error. Include safe error details or document why this log omits them.',
    },
    schema: [],
  },
  create(context) {
    return {
      CatchClause(node) {
        // A read may feed a log, recovery, or propagation. Leave its data flow to review.
        const readsCaughtError = context.sourceCode.getDeclaredVariables(node).some(
          (variable) => variable.references.some((reference) => reference.isRead()),
        );
        if (readsCaughtError) return;

        for (const statement of node.body.body) {
          if (statement.type === 'ExpressionStatement' && isLogCall(statement.expression)) {
            context.report({ node: statement.expression, messageId: 'missingError' });
          }
        }
      },
    };
  },
};

export const catchLintPlugin = {
  rules: { 'catch-log-includes-error': catchLogIncludesError },
};

export const catchRules = {
  'takt/catch-log-includes-error': 'error',
};
