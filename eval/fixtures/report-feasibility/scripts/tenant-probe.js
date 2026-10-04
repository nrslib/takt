if (!process.env.TAKT_FEASIBILITY_TENANT_CREDENTIAL) {
  console.error('MISSING_TENANT_CREDENTIAL: no request attempted');
  process.exitCode = 2;
} else {
  console.error('External endpoint access is outside this evaluator; no request attempted');
  process.exitCode = 3;
}
