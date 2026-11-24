import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT, expandHome } from "../config";

/**
 * Google OAuth for the Comms agent (docs/GMAIL-SETUP.md, ARCHITECTURE.md 8.4 and 9.6).
 *
 * Two scopes, ever: read mail and manage drafts. The refresh token lives in one file on the connector
 * machine (mode 600), is never sent to the hub or a client, and is never written to a log. The owner's
 * Google password is typed only into Google's own page in the owner's own browser.
 */

export const SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPE_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
/** The whole allowlist. Nothing that can modify, label, delete or change settings. */
export const REQUIRED_SCOPES = [SCOPE_READONLY, SCOPE_COMPOSE] as const;

export const shortScope = (s: string) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");

export interface GmailEndpoints {
  /** Gmail REST base, without a trailing slash. */
  api: string;
  auth: string;
  token: string;
  revoke: string;
  tokenInfo: string;
}

export const GOOGLE_ENDPOINTS: GmailEndpoints = {
  api: "https://gmail.googleapis.com",
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  tokenInfo: "https://oauth2.googleapis.com/tokeninfo",
};

const isLoopbackUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Google's endpoints, unless HB_GMAIL_FAKE_BASE points at a local stand-in for tests. Only a loopback
 * address is accepted there, so a stray variable can never send a real token to another host.
 */
export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): GmailEndpoints {
  const fake = env.HB_GMAIL_FAKE_BASE?.replace(/\/+$/, "");
  if (!fake) return GOOGLE_ENDPOINTS;
  if (!isLoopbackUrl(fake)) throw new Error("HB_GMAIL_FAKE_BASE must be a loopback http address (127.0.0.1 or localhost). It is for tests only.");
  return { api: fake, auth: `${fake}/o/oauth2/v2/auth`, token: `${fake}/token`, revoke: `${fake}/revoke`, tokenInfo: `${fake}/tokeninfo` };
}

export interface GmailPaths {
  secretsDir: string;
  clientJson: string;
  token: string;
  /** Watcher cursor and the send ledger. No secrets. */
  state: string;
}

export function gmailPaths(env: NodeJS.ProcessEnv = process.env): GmailPaths {
  const dataDir = resolve(expandHome(env.HOMEBASE_DATA_DIR ?? env.DATA_DIR ?? resolve(REPO_ROOT, "data")));
  const secretsDir = resolve(expandHome(env.HB_GMAIL_SECRETS_DIR ?? join(dataDir, "secrets")));
  return {
    secretsDir,
    clientJson: resolve(expandHome(env.HB_GMAIL_CLIENT_JSON ?? join(secretsDir, "google-oauth-client.json"))),
    token: join(secretsDir, "gmail-token.json"),
    state: join(dataDir, "gmail-state.json"),
  };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the "Desktop app" client JSON downloaded from Google Cloud. */
export function loadOAuthClient(path: string): OAuthClient {
  if (!existsSync(path)) throw new Error(`OAuth client file not found at ${path}. Download the Desktop app client JSON from Google Cloud and put it there (docs/GMAIL-SETUP.md).`);
  let j: any;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (j?.web && !j.installed) throw new Error('That file is for a "Web application" client. Create an OAuth client ID of type "Desktop app" and download its JSON instead.');
  const c = j?.installed;
  if (!c || typeof c.client_id !== "string" || typeof c.client_secret !== "string") {
    throw new Error(`${path} does not look like a Desktop app OAuth client file (no "installed" section with client_id and client_secret).`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

/** The stored grant. `refreshToken` is the secret; the rest is what `gmail:status` prints. */
export interface StoredToken {
  refreshToken: string;
  scopes: string[];
  account: string | null;
  obtainedAt: number;
}

export function saveToken(paths: GmailPaths, t: StoredToken) {
  mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.secretsDir, 0o700);
  } catch {
    // Windows has no modes
  }
  writeFileSync(paths.token, JSON.stringify(t, null, 2), { mode: 0o600 });
  try {
    chmodSync(paths.token, 0o600); // also when the file already existed with other bits
  } catch {
    // Windows
  }
}

export function loadToken(paths: GmailPaths): StoredToken | null {
  if (!existsSync(paths.token)) return null;
  try {
    const j = JSON.parse(readFileSync(paths.token, "utf8"));
    if (typeof j?.refreshToken !== "string" || !j.refreshToken) return null;
    return { refreshToken: j.refreshToken, scopes: Array.isArray(j.scopes) ? j.scopes.map(String) : [], account: typeof j.account === "string" ? j.account : null, obtainedAt: Number(j.obtainedAt) || 0 };
  } catch {
    return null;
  }
}

export function deleteToken(paths: GmailPaths) {
  for (const p of [paths.token, paths.state]) if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------- scopes

export interface ScopeCheck {
  ok: boolean;
  granted: string[];
  extra: string[];
  missing: string[];
}

/** Exactly the two scopes, or it is refused. `granted` is the space-separated list from Google's token response. */
export function checkGrantedScopes(granted: string | string[] | null | undefined): ScopeCheck {
  const list = (Array.isArray(granted) ? granted : String(granted ?? "").split(/\s+/)).map((s) => s.trim()).filter(Boolean);
  const set = [...new Set(list)];
  const allowed = new Set<string>(REQUIRED_SCOPES);
  const extra = set.filter((s) => !allowed.has(s));
  const missing = REQUIRED_SCOPES.filter((s) => !set.includes(s));
  return { ok: extra.length === 0 && missing.length === 0, granted: set, extra, missing };
}

// ---------------------------------------------------------------- consent flow

/** The loopback port the consent redirect uses. Nothing has to listen there for the paste-back route. */
export const LOOPBACK_PORT = 53682;
export const redirectUri = (port = LOOPBACK_PORT) => `http://127.0.0.1:${port}/`;

export interface ConsentRequest {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export function buildConsentRequest(client: OAuthClient, ep: GmailEndpoints = GOOGLE_ENDPOINTS, port = LOOPBACK_PORT): ConsentRequest {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(port),
    response_type: "code",
    scope: REQUIRED_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${ep.auth}?${q.toString()}`, state, verifier, redirectUri: redirectUri(port) };
}

/** Accepts what the owner pastes back: the whole redirect URL from the address bar, or just the code. */
export function parseRedirect(pasted: string, expectedState: string): { code: string } | { error: string } {
  const s = pasted.trim().replace(/^["']|["']$/g, "");
  if (!s) return { error: "Nothing was pasted." };
  if (/^https?:\/\//i.test(s) || s.includes("code=") || s.includes("error=")) {
    let q: URLSearchParams;
    try {
      q = /^https?:\/\//i.test(s) ? new URL(s).searchParams : new URLSearchParams(s.replace(/^[^?]*\?/, ""));
    } catch {
      return { error: "That does not look like a URL." };
    }
    if (q.get("error")) return { error: `Google reported: ${q.get("error")}` };
    const code = q.get("code");
    if (!code) return { error: "There is no code in that URL. Copy the whole address from the browser's address bar." };
    if (q.get("state") !== expectedState) return { error: "The state value does not match this sign-in. Start again with a fresh URL." };
    return { code };
  }
  if (/\s/.test(s) || s.length < 10) return { error: "That does not look like an authorization code." };
  return { code: s };
}

type Fetch = typeof fetch;

async function tokenRequest(ep: GmailEndpoints, body: Record<string, string>, fetchFn: Fetch): Promise<any> {
  const res = await fetchFn(ep.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  let j: any = null;
  try {
    j = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    // Google's error bodies carry a code and a description, never a token.
    const err = new Error(`Google token endpoint: ${j?.error ?? res.status}${j?.error_description ? ` (${j.error_description})` : ""}`);
    (err as any).oauthError = j?.error ?? null;
    throw err;
  }
  return j;
}

export async function revokeToken(ep: GmailEndpoints, token: string, fetchFn: Fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(ep.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
    return res.ok;
  } catch {
    return false;
  }
}

export type AuthResult =
  | { ok: true; account: string | null; scopes: string[] }
  | { ok: false; reason: "extra_scopes" | "missing_scopes" | "no_refresh_token"; message: string; check?: ScopeCheck; revoked?: boolean };

/**
 * Trades the authorization code for tokens and stores the refresh token, but only when Google granted
 * exactly the two scopes. Anything broader is revoked on the spot and nothing is written to disk.
 */
export async function completeAuth(o: {
  client: OAuthClient; code: string; request: Pick<ConsentRequest, "verifier" | "redirectUri">; paths: GmailPaths;
  endpoints?: GmailEndpoints; fetchFn?: Fetch; now?: () => number;
}): Promise<AuthResult> {
  const ep = o.endpoints ?? GOOGLE_ENDPOINTS;
  const fetchFn = o.fetchFn ?? fetch;
  const j = await tokenRequest(ep, {
    grant_type: "authorization_code", code: o.code, client_id: o.client.clientId, client_secret: o.client.clientSecret,
    redirect_uri: o.request.redirectUri, code_verifier: o.request.verifier,
  }, fetchFn);
  const check = checkGrantedScopes(j.scope);
  const secret: string | undefined = j.refresh_token ?? j.access_token;
  if (check.extra.length) {
    const revoked = secret ? await revokeToken(ep, secret, fetchFn) : false;
    return {
      ok: false, reason: "extra_scopes", check, revoked,
      message: `Google granted more than HomeBase asked for: ${check.extra.map(shortScope).join(", ")}. Nothing was saved${revoked ? " and the grant was revoked" : ""}. `
        + "Remove the extra scopes from the consent screen's Data Access page and run gmail:auth again.",
    };
  }
  if (check.missing.length) {
    const revoked = secret ? await revokeToken(ep, secret, fetchFn) : false;
    return {
      ok: false, reason: "missing_scopes", check, revoked,
      message: `Google did not grant ${check.missing.map(shortScope).join(" and ")}. Both boxes must stay ticked on the consent page. Nothing was saved. Run gmail:auth again.`,
    };
  }
  if (typeof j.refresh_token !== "string" || !j.refresh_token) {
    return { ok: false, reason: "no_refresh_token", message: "Google did not return a refresh token. Remove HomeBase at https://myaccount.google.com/permissions and run gmail:auth again." };
  }
  let account: string | null = null;
  try {
    const res = await fetchFn(`${ep.api}/gmail/v1/users/me/profile`, { headers: { Authorization: `Bearer ${j.access_token}` } });
    if (res.ok) account = String(((await res.json()) as any).emailAddress ?? "") || null;
  } catch {
    // the account name is a convenience; the connector reads it again later
  }
  saveToken(o.paths, { refreshToken: j.refresh_token, scopes: check.granted, account, obtainedAt: (o.now ?? Date.now)() });
  return { ok: true, account, scopes: check.granted };
}

// ---------------------------------------------------------------- access tokens

export class GmailAuthError extends Error {
  constructor(message: string, public code: "not_connected" | "revoked" | "scope" | "network") {
    super(message);
  }
}

/** Hands out short-lived access tokens, refreshing from the stored grant. Tokens stay in memory. */
export class AccessTokens {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(private o: { paths: GmailPaths; endpoints: GmailEndpoints; fetchFn?: Fetch; now?: () => number }) {}

  reset() {
    this.token = null;
    this.expiresAt = 0;
  }

  get(): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    if (this.token && now < this.expiresAt - 60_000) return Promise.resolve(this.token);
    return (this.inflight ??= this.refresh().finally(() => (this.inflight = null)));
  }

  private async refresh(): Promise<string> {
    const stored = loadToken(this.o.paths);
    if (!stored) throw new GmailAuthError("Gmail is not connected.", "not_connected");
    // A grant that is broader than the allowlist is never used, however it got into the file.
    const check = checkGrantedScopes(stored.scopes);
    if (check.extra.length) throw new GmailAuthError(`The stored Gmail grant has scopes HomeBase must not hold (${check.extra.map(shortScope).join(", ")}). Run gmail:revoke, then gmail:auth.`, "scope");
    const client = loadOAuthClient(this.o.paths.clientJson);
    let j: any;
    try {
      j = await tokenRequest(this.o.endpoints, { grant_type: "refresh_token", refresh_token: stored.refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, this.o.fetchFn ?? fetch);
    } catch (err) {
      const code = (err as any).oauthError;
      if (code === "invalid_grant") throw new GmailAuthError("Google no longer accepts the stored Gmail grant (it expired or was revoked).", "revoked");
      throw new GmailAuthError((err as Error).message, code ? "revoked" : "network");
    }
    if (j.scope) {
      const live = checkGrantedScopes(j.scope);
      if (live.extra.length) throw new GmailAuthError(`Google reports extra scopes on this grant (${live.extra.map(shortScope).join(", ")}). Run gmail:revoke, then gmail:auth.`, "scope");
    }
    this.token = String(j.access_token);
    this.expiresAt = (this.o.now ?? Date.now)() + Math.max(60, Number(j.expires_in) || 3600) * 1000;
    return this.token;
  }
}

export const authHint = (host = hostname()) => `run gmail:auth on ${host.split(".")[0] || "the connector machine"}`;
export const NOTE_NOT_CONNECTED = (host?: string) => `Gmail not connected — ${authHint(host)}`;
export const NOTE_NO_CLIENT = (host?: string) => `Gmail not connected — put google-oauth-client.json in ~/homebase-data/secrets, then ${authHint(host)}`;
export const NOTE_REVOKED = (host?: string) => `Gmail access expired or was revoked — ${authHint(host)}`;

/** What can be said without touching the network: is there a client file and a stored grant? */
export function localStatus(paths: GmailPaths): { clientFile: boolean; token: StoredToken | null; note: string | null } {
  const clientFile = existsSync(paths.clientJson);
  const token = loadToken(paths);
  const note = token && clientFile ? null : !clientFile && !token ? NOTE_NO_CLIENT() : NOTE_NOT_CONNECTED();
  return { clientFile, token, note };
}

export const ensureDir = (file: string) => mkdirSync(dirname(file), { recursive: true });
