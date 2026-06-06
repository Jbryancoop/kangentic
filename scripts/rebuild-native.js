// Rebuild only better-sqlite3 against Electron's Node headers.
// node-pty ships NAPI prebuilts and must NOT be rebuilt (winpty's
// GetCommitHash.bat breaks on Windows).
//
// @electron/rebuild v4 is ESM-only, so we use dynamic import().
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const electronVersion = require(path.join(projectDir, 'node_modules', 'electron', 'package.json')).version;

import('@electron/rebuild').then(({ rebuild }) => {
  return rebuild({
    buildPath: projectDir,
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3'],
  });
}).then(() => {
  console.log('[rebuild] better-sqlite3 rebuilt for Electron', electronVersion);
}).catch((err) => {
  // When run via postinstall, don't fail the entire install - the user can
  // run `npm run rebuild` manually after closing Electron. When run directly
  // via `npm run rebuild` (used by package/make scripts), fail hard.
  const isPostInstall = process.env.npm_lifecycle_event === 'postinstall';
  if (isPostInstall) {
    console.warn('[rebuild] Warning: could not rebuild better-sqlite3 (file may be locked by a running Electron process).');
    console.warn('[rebuild] Run `npm run rebuild` manually after closing the app.');
  } else {
    console.error('[rebuild] Failed:', err);
    process.exit(1);
  }
});
