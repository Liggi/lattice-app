#!/usr/bin/env node
// Refuse to pack/publish with a local-path dependency that consumers must resolve.
// lattice-orchestrator@2.1.0 shipped with
//   "@liggi/agent-ui-harness": "file:/path/to/agent-ui-harness/...tgz"
// which installs fine on the author's machine and fails ENOENT everywhere else.
// devDependencies are exempt: npm never installs them for consumers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const CONSUMER_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const LOCAL_SPEC = /^(file|link|portal):/;

const offenders = [];
for (const section of CONSUMER_SECTIONS) {
  for (const [name, spec] of Object.entries(pkg[section] || {})) {
    if (LOCAL_SPEC.test(spec)) offenders.push({ section, name, spec });
  }
}

if (offenders.length > 0) {
  console.error('ERROR: local-path dependencies cannot be published — consumers will fail to install:');
  for (const { section, name, spec } of offenders) {
    console.error(`  ${section}.${name} = ${spec}`);
  }
  console.error('Publish the package to the registry and depend on a version range instead.');
  process.exit(1);
}
