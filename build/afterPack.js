// Sets icon and version info on Aurora.exe without needing Wine (pure JS PE editing).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRawHeader } = require('@electron/asar');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

// Electron "fuses": compile-time switches that close known abuse paths.
const FUSES = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false,
  [FuseV1Options.RunAsNode]: false,                         // Aurora.exe can't be abused as a Node.js runtime
  [FuseV1Options.EnableCookieEncryption]: true,             // cookies encrypted with Windows DPAPI
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,     // no --inspect debugging hooks
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, // refuse to start if app code was altered
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};
exports.FUSES = FUSES;

exports.default = async function afterPack(context) {
  const ResEdit = await import('resedit');
  const pkg = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${pkg.productFilename}.exe`);
  if (context.electronPlatformName !== 'win32') {
    const { [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: _skip, ...rest } = FUSES; // integrity: Windows/macOS only
    await flipFuses(path.join(context.appOutDir, context.packager.executableName || 'antares'), rest);
    return;
  }
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const langs = vi.getAllLanguagesForStringValues();
  for (const l of langs) {
    vi.setStringValues(l, {
      FileDescription: 'Antares', ProductName: 'Antares', CompanyName: 'Antares',
      InternalName: 'Antares', OriginalFilename: 'Antares.exe', LegalCopyright: `Copyright © ${new Date().getFullYear()} Antares`,
      FileVersion: pkg.version, ProductVersion: pkg.version,
    });
  }
  vi.outputToResourceEntries(res.entries);

  // Embedded ASAR integrity (checked by Electron at startup when the fuse is on)
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  const hash = crypto.createHash('sha256').update(getRawHeader(asarPath).headerString).digest('hex');
  const integrity = [{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }];
  const langInfo = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  res.entries = res.entries.filter((e) => !(String(e.type).toUpperCase() === 'INTEGRITY'));
  res.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', bin: Buffer.from(JSON.stringify(integrity)), lang: langInfo.lang, codepage: langInfo.codepage });
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  await flipFuses(exePath, FUSES);
  console.log('  • afterPack: icon, version info, asar integrity and fuses applied to', path.basename(exePath));
};
