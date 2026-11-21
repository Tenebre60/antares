// Builds the Windows installer on Linux without Wine: electron-builder's pure-JS uninstaller
// extraction (normally used on macOS) is enabled instead of running the installer under Wine.
const macosVersion = require('app-builder-lib/out/util/macosVersion');
macosVersion.isMacOsCatalina = () => true;
const builder = require('electron-builder');
builder.build({ targets: builder.Platform.WINDOWS.createTarget() })
  .then((files) => { console.log('ok:\n' + files.join('\n')); })
  .catch((e) => { console.error(e); process.exit(1); });
