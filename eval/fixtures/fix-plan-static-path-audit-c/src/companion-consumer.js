export function resolveDirectCompanion(config) {
  return {
    name: config.companion.direct.name,
    entry: config.companion.direct.entry,
    terminal: 'direct companion entry',
  };
}

export function resolveCompanionReference(config, input) {
  const reference = config.companion.companion_ref;
  const explicitArgs = input.explicitArgs;
  const unknownArg = Object.keys(explicitArgs)
    .find((name) => !reference.args.includes(name));
  if (unknownArg !== undefined) {
    throw new Error(`Unknown companion argument: ${unknownArg}`);
  }

  const resolvedArgs = {};
  for (const name of reference.args) {
    if (Object.hasOwn(explicitArgs, name)) {
      resolvedArgs[name] = explicitArgs[name];
    } else if (Object.hasOwn(reference.defaults, name)) {
      resolvedArgs[name] = reference.defaults[name];
    } else {
      throw new Error(`Missing companion argument: ${name}`);
    }
  }

  return {
    defaults: reference.defaults,
    explicitArgs,
    args: resolvedArgs,
    terminal: 'companion invocation',
  };
}

export function resolveCapabilities(config, mode) {
  if (!Object.hasOwn(config.capabilities, mode)) {
    throw new Error(`Unknown capability mode: ${mode}`);
  }
  return {
    mode,
    capabilities: config.capabilities[mode],
    terminal: 'capability set',
  };
}

export function resolveScopedFacet(config, packageName, facetName) {
  const packageConfig = config.repertoires.packages[packageName];
  if (packageConfig === undefined) {
    throw new Error(`Unknown repertoire package: ${packageName}`);
  }
  if (!Object.hasOwn(packageConfig.facets, facetName)) {
    throw new Error(`Unknown package facet: ${packageName}/${facetName}`);
  }
  return {
    packageName,
    facetName,
    content: packageConfig.facets[facetName],
    terminal: 'package-scoped facet content',
  };
}
