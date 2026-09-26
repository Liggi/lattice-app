/**
 * Print the config dir the server in this checkout uses, so shell scripts
 * (service setup, logs, `pnpm dev`) follow the same constant instead of
 * assuming ~/.lattice, which belongs to the older npm release.
 */

import { CONFIG_DIR } from '../src/utils/constants.js';

console.log(CONFIG_DIR);
