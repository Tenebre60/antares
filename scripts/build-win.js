// Builds the Windows installer and portable version.
// - On Windows (GitHub Actions) it is a normal electron-builder build; with --publish the release
//   files (installer, latest.yml with the SHA-512) are uploaded to GitHub Releases.
// - On Linux it builds without Wine: electron-builder's pure-JS uninstaller extraction (normally
//   used on macOS) is enabled instead of running the installer under Wine, and a local copy of the
//   Windows Electron zip in build/electron-dist is used when present.
const fs = require('fs');
const path = require('path');
const publish = process.argv.includes('--publish') ? 'always' : 'never';
const config = {};
if (process.platform !== 'win32') {
  require('app-builder-lib/out/util/macosVersion').isMacOsCatalina = () => true;
  const local = path.join(__dirname, '..', 'build', 'electron-dist');
  if (fs.existsSync(local) && fs.readdirSync(local).some((f) => f.endsWith('win32-x64.zip'))) config.electronDist = local;
}
const builder = require('electron-builder');
builder.build({ targets: builder.Platform.WINDOWS.createTarget(), publish, config })
  .then((files) => { console.log('ok:\n' + files.join('\n')); })
  .catch((e) => { console.error(e); process.exit(1); });
