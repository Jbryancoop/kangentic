const path = require('path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[afterSign] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set (dev build).');
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  console.log(`[afterSign] Notarizing ${appPath} with notarytool...`);
  const start = Date.now();
  // @electron/notarize v3 is ESM-only; load it dynamically so this CommonJS
  // electron-builder hook can consume it on Node 22.12+ regardless of host.
  const { notarize } = await import('@electron/notarize');
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  const elapsedSeconds = Math.round((Date.now() - start) / 1000);
  console.log(`[afterSign] Notarized in ${elapsedSeconds}s`);
};
