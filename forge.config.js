const path = require('path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// electron-winstaller currently calls resetSignTool() even when windowsSign
// is not configured, which triggers DEP0187 on newer Node versions.
// For unsigned Squirrel builds, this reset step is unnecessary.
(() => {
  try {
    const sign = require('electron-winstaller/lib/sign');
    if (!sign || typeof sign.resetSignTool !== 'function') {
      return;
    }

    if (sign.resetSignTool.__qwaleNoopPatched) {
      return;
    }

    const noop = async () => {};
    noop.__qwaleNoopPatched = true;
    sign.resetSignTool = noop;
  } catch {
    // Ignore if internals change in future electron-winstaller versions.
  }
})();

module.exports = {
  packagerConfig: {
    asar: true,
    // Used for the packaged app executable icon (Windows expects .ico).
    icon: path.join(__dirname, 'src/renderer/assets/desktop-app-logo'),
    // Ad-hoc sign the mac build (no paid Apple Developer cert needed) so
    // Gatekeeper doesn't report the downloaded/quarantined app as "damaged".
    // Users still see an "unidentified developer" prompt, which is bypassable.
    osxSign: {
      identity: '-',
      identityValidation: false,
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // iconUrl is used by Squirrel metadata (Add/Remove Programs), not the app EXE icon.
        iconUrl: path.join(__dirname, 'src/renderer/assets/desktop-app-logo.ico'),
        setupIcon: path.join(__dirname, 'src/renderer/assets/setup-app-logo.ico'),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        // Packager names the binary from packagerConfig/productName ("QwaleCode"),
        // but electron-installer-debian defaults to package.json's "name" field
        // ("qwalecode") when this isn't set, so it can't find the binary.
        options: { bin: 'QwaleCode' },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: { bin: 'QwaleCode' },
      },
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'faqro',
          name: 'qwale-code',
        },
        prerelease: false,
        draft: false,
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
