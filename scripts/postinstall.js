#!/usr/bin/env node

import { chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// List of files that need executable permissions
const executableFiles = [
  'dist/server.js',
  'dist/cli.js',
];

// node-pty spawn-helper paths vary by package manager and install method
// Try multiple possible locations
const spawnHelperPaths = [
  // npm flat structure (inside our package)
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  // npm flat structure (sibling - npx install)
  '../node-pty/prebuilds/darwin-arm64/spawn-helper',
  // pnpm nested structure
  'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  // darwin-x64 variants
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  '../node-pty/prebuilds/darwin-x64/spawn-helper',
];

console.log('Setting executable permissions...');

executableFiles.forEach(file => {
  const filePath = join(__dirname, '..', file);
  try {
    chmodSync(filePath, '755');
    console.log(`✓ Made ${file} executable`);
  } catch (error) {
    // Don't warn for missing files - they may not exist in all installs
    if (error.code !== 'ENOENT') {
      console.error(`✗ Failed to make ${file} executable:`, error.message);
    }
  }
});

// Fix spawn-helper on macOS (try all possible paths)
for (const spawnHelper of spawnHelperPaths) {
  const filePath = join(__dirname, '..', spawnHelper);
  if (existsSync(filePath)) {
    try {
      chmodSync(filePath, '755');
      console.log(`✓ Made spawn-helper executable`);
      break; // Only need to fix one
    } catch (error) {
      console.error(`✗ Failed to make spawn-helper executable:`, error.message);
    }
  }
}

console.log('Postinstall complete.');