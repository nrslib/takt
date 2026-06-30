#!/usr/bin/env bash
set -euo pipefail

npm run build
npm run lint
npm test
npm run test:it
npm run test:e2e:mock
