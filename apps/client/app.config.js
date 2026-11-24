// Expo config: app.json plus what a fork or a private build sets in the environment or in the repo's untracked
// .env.local (see .env.example). Only HOMEBASE_* keys are read from that file, so nothing from it is inlined in a bundle.
//   HOMEBASE_APP_ID   Android package name (default com.kotashbuilds.homebase). scripts/android.mjs uses the same value.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parseEnv } = require("node:util");

function localEnv() {
  const file = join(__dirname, "..", "..", ".env.local");
  if (!existsSync(file)) return {};
  return Object.fromEntries(Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(([k]) => k.startsWith("HOMEBASE_")));
}

module.exports = ({ config }) => {
  const appId = (process.env.HOMEBASE_APP_ID ?? localEnv().HOMEBASE_APP_ID)?.trim();
  return { ...config, android: { ...config.android, package: appId || config.android.package } };
};
