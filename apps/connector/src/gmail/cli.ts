#!/usr/bin/env node
// One-time Gmail sign-in for the Comms agent, run by the owner on the connector machine.
//   npm run gmail:auth   -w @homebase/connector [-- /path/to/client.json]
//   npm run gmail:status -w @homebase/connector
//   npm run gmail:revoke -w @homebase/connector
// See docs/GMAIL-SETUP.md. This never asks for, sees or stores a Google password.
import "../env";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import {
  AccessTokens, LOOPBACK_PORT, REQUIRED_SCOPES, buildConsentRequest, checkGrantedScopes, completeAuth, deleteToken, endpointsFromEnv, gmailPaths,
  loadOAuthClient, loadToken, parseRedirect, revokeToken, shortScope,
} from "./auth";
import { expandHome } from "../config";
import { resolve } from "node:path";

const out = (s = "") => process.stdout.write(`${s}\n`);

async function auth(argPath?: string) {
  const paths = gmailPaths();
  const ep = endpointsFromEnv();
  const clientPath = argPath ? resolve(expandHome(argPath)) : paths.clientJson;
  const client = loadOAuthClient(clientPath);
  if (argPath) paths.clientJson = clientPath;
  const req = buildConsentRequest(client, ep);
  const host = hostname().split(".")[0];

  out();
  out("HomeBase · connect Gmail for the Comms agent");
  out();
  out("HomeBase asks Google for exactly two permissions:");
  for (const s of REQUIRED_SCOPES) out(`  - ${shortScope(s)}   ${s.endsWith("readonly") ? "read mail" : "create, change and send drafts"}`);
  out("It cannot delete, archive or label mail, or change any setting. If Google's page lists anything else, stop and close it.");
  out();
  out("1. Open this address in the browser on your own computer or phone and sign in with the mailbox HomeBase should use:");
  out();
  out(req.url);
  out();
  out("2. Approve both permissions. Your browser is then sent to an address that starts with");
  out(`     ${req.redirectUri}?state=...&code=...`);
  out('   and shows "This site can\'t be reached". That is expected: the address points at this server, not at your computer.');
  out("3. Copy the whole address from the browser's address bar, paste it here and press Enter.");
  out();
  out(`   (Optional, instead of step 3: before step 1, open a tunnel from your computer with   ssh -N -L ${LOOPBACK_PORT}:127.0.0.1:${LOOPBACK_PORT} ${host}`);
  out("    and the page finishes by itself.)");
  out();

  // Either route delivers the code: the pasted address, or the browser reaching this listener through a tunnel.
  let finish: (pasted: string) => void = () => {};
  const arm = () => new Promise<string>((r) => (finish = r));
  let got = arm();
  const server = createServer((q, res) => {
    const url = new URL(q.url ?? "/", req.redirectUri);
    if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("HomeBase received the answer from Google. You can close this tab and go back to the terminal.");
    finish(url.toString());
  });
  server.on("error", () => {}); // port busy: the paste-back route still works
  server.listen(LOOPBACK_PORT, "127.0.0.1");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let code: string | null = null;
  try {
    for (let tries = 0; tries < 5 && !code; tries++) {
      const pasted = await Promise.race([got, new Promise<string>((r) => rl.question("Paste the address here: ", r))]);
      const parsed = parseRedirect(pasted, req.state);
      if ("code" in parsed) code = parsed.code;
      else {
        out(`  ${parsed.error}`);
        got = arm();
      }
    }
  } finally {
    rl.close();
    server.close();
  }
  if (!code) {
    out("No valid answer. Nothing was saved. Run gmail:auth again for a fresh address.");
    process.exit(1);
  }

  const result = await completeAuth({ client, code, request: req, paths, endpoints: ep });
  out();
  if (!result.ok) {
    if (result.check) out(`Google granted: ${result.check.granted.map(shortScope).join(", ") || "(nothing)"}`);
    out(`REFUSED. ${result.message}`);
    process.exit(2);
  }
  out(`Connected: ${result.account ?? "(account name not available)"}`);
  out(`Granted scopes: ${result.scopes.map(shortScope).join(", ")}`);
  out(`The refresh token is stored in ${paths.token} (readable by this user only). It is not shown and never leaves this machine.`);
  out('The Comms agent picks it up within a minute; its "Gmail not connected" note then disappears in the app.');
}

async function status() {
  const paths = gmailPaths();
  const ep = endpointsFromEnv();
  const stored = loadToken(paths);
  out(`OAuth client file: ${paths.clientJson} ${(() => { try { loadOAuthClient(paths.clientJson); return "(found)"; } catch (e) { return `(problem: ${(e as Error).message})`; } })()}`);
  if (!stored) {
    out("Gmail: not connected. Run gmail:auth.");
    process.exit(1);
  }
  out(`Account (at sign-in): ${stored.account ?? "unknown"}`);
  out(`Scopes (at sign-in): ${stored.scopes.map(shortScope).join(", ")}`);
  out(`Connected since: ${stored.obtainedAt ? new Date(stored.obtainedAt).toISOString() : "unknown"}`);
  try {
    const tokens = new AccessTokens({ paths, endpoints: ep });
    const access = await tokens.get();
    const profile: any = await (await fetch(`${ep.api}/gmail/v1/users/me/profile`, { headers: { Authorization: `Bearer ${access}` } })).json();
    const info: any = await (await fetch(ep.tokenInfo, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: access }).toString() })).json();
    const live = checkGrantedScopes(info?.scope ?? stored.scopes);
    out(`Account (now): ${profile?.emailAddress ?? "unknown"}`);
    out(`Scopes (now, from Google): ${live.granted.map(shortScope).join(", ")}${live.extra.length ? "   <-- MORE THAN HOMEBASE ALLOWS; run gmail:revoke" : ""}`);
    out(live.ok ? "Gmail: connected." : "Gmail: connected, but the scopes are not exactly gmail.readonly + gmail.compose.");
    process.exit(live.extra.length ? 2 : 0);
  } catch (err) {
    out(`Gmail: the stored grant does not work (${(err as Error).message}). Run gmail:auth.`);
    process.exit(1);
  }
}

async function revoke() {
  const paths = gmailPaths();
  const stored = loadToken(paths);
  if (!stored) {
    out("Gmail is not connected; there is nothing to revoke.");
    return;
  }
  const ok = await revokeToken(endpointsFromEnv(), stored.refreshToken);
  deleteToken(paths);
  out(ok ? "Google has revoked HomeBase's access." : "Could not reach Google to revoke the grant. Remove HomeBase yourself at https://myaccount.google.com/permissions");
  out(`The stored token was deleted from ${paths.token}. The Comms agent shows "Gmail not connected" within a minute.`);
}

const [cmd, arg] = process.argv.slice(2);
const run = cmd === "auth" ? auth(arg) : cmd === "status" ? status() : cmd === "revoke" ? revoke() : Promise.reject(new Error("Usage: gmail <auth [client.json] | status | revoke>"));
run.catch((err) => {
  // Messages here come from this file and from Google's error codes; tokens are never part of them.
  console.error(`gmail: ${(err as Error).message}`);
  process.exit(1);
});
