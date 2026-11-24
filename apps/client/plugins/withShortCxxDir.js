// Windows only: React Native's CMake/ninja step embeds absolute node_modules paths in object file names,
// which pushes them past the 260-character limit when the repo lives under a deep folder.
// Pointing the CMake staging directory at a short path keeps every object path legal without
// touching system long-path settings. scripts/android.mjs sets HB_CXX_DIR; without it this plugin does nothing.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// homebase: short CMake staging dir";

module.exports = function withShortCxxDir(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(MARKER)) return cfg;
    cfg.modResults.contents += `
${MARKER}
def hbCxxDir = System.getenv("HB_CXX_DIR") ?: "off"
if (hbCxxDir != "off") {
    android {
        externalNativeBuild {
            cmake {
                buildStagingDirectory file("\${hbCxxDir}/app")
            }
        }
    }
}
`;
    return cfg;
  });
};
