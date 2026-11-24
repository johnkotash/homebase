import { createHash, randomBytes, randomInt } from "node:crypto";
import { newId, type Device } from "@homebase/protocol";
import type { SqlStore, SqlValue } from "./hub/SqlStore";
import { readEntity } from "./hub/tables";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface AuthedDevice {
  id: string;
  kind: "device" | "connector";
  name: string;
  platform: string;
  canApprove: boolean;
  workspaceId: string;
}

/** Devices, tokens and pairing codes. D1 in production; the same SQLite file in the prototype. */
export class Directory {
  constructor(private store: SqlStore, private now: () => number = Date.now) {}

  workspaceId(): string {
    const row = this.store.get<{ id: string }>("SELECT id FROM workspaces LIMIT 1");
    if (!row) throw new Error("workspace not seeded");
    return row.id;
  }

  createPairingCode(kind: "device" | "connector", createdBy: string | null, ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
    let raw = "";
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = this.now() + ttlMs;
    this.store.run(
      "INSERT INTO pairing_codes (code_hash, workspace_id, kind, created_by, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)",
      sha256(raw), this.workspaceId(), kind, createdBy, expiresAt,
    );
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** Consumes a pairing code and creates the device row. Returns the one-time-visible token. */
  pair(input: { code: string; kind: "device" | "connector"; name: string; platform: string }):
    | { ok: true; token: string; deviceId: string; workspaceId: string }
    | { ok: false; code: string; message: string } {
    const hash = sha256(normalizeCode(input.code));
    const now = this.now();
    return this.store.transaction(() => {
      const row = this.store.get<{ kind: string; expires_at: number; used_at: number | null; workspace_id: string }>(
        "SELECT * FROM pairing_codes WHERE code_hash = ?", hash,
      );
      if (!row) return { ok: false as const, code: "invalid_code", message: "That pairing code is not recognised." };
      if (row.used_at != null) return { ok: false as const, code: "code_used", message: "That pairing code was already used." };
      if (row.expires_at < now) return { ok: false as const, code: "code_expired", message: "That pairing code has expired." };
      if (row.kind !== input.kind) {
        return { ok: false as const, code: "wrong_kind", message: `That code is for a ${row.kind}, not a ${input.kind}.` };
      }
      this.store.run("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?", now, hash);
      const deviceId = newId(input.kind === "device" ? "dev" : "con");
      const token = `${input.kind === "device" ? "hb_dev_" : "hb_con_"}${randomBytes(32).toString("base64url")}`;
      this.store.run(
        `INSERT INTO devices (id, workspace_id, user_id, kind, name, platform, token_hash, can_approve, online, last_seen_at, revoked_at, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
        deviceId, row.workspace_id, input.kind, input.name, input.platform, sha256(token), input.kind === "device" ? 1 : 0, now,
      );
      this.store.run(
        "INSERT INTO audit_log (id, at, actor_id, action, subject_type, subject_id, detail) VALUES (?, ?, ?, 'device.pair', 'device', ?, ?)",
        newId("aud"), now, deviceId, deviceId, JSON.stringify({ kind: input.kind, name: input.name, platform: input.platform }),
      );
      return { ok: true as const, token, deviceId, workspaceId: row.workspace_id };
    });
  }

  authenticate(token: string | undefined | null): AuthedDevice | null {
    if (!token) return null;
    const row = this.store.get<Record<string, SqlValue>>("SELECT * FROM devices WHERE token_hash = ?", sha256(token));
    if (!row || row.revoked_at != null) return null;
    return {
      id: row.id as string, kind: row.kind as any, name: row.name as string, platform: row.platform as string,
      canApprove: !!row.can_approve, workspaceId: row.workspace_id as string,
    };
  }

  createIntegrationToken(name: string): string {
    const token = `hb_int_${randomBytes(32).toString("base64url")}`;
    this.store.run(
      "INSERT INTO integration_tokens (id, workspace_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId("tok"), this.workspaceId(), name, sha256(token), JSON.stringify(["ingest"]), this.now(),
    );
    return token;
  }

  authenticateIntegration(token: string | undefined | null): boolean {
    if (!token) return false;
    const row = this.store.get<{ revoked_at: number | null }>("SELECT revoked_at FROM integration_tokens WHERE token_hash = ?", sha256(token));
    return !!row && row.revoked_at == null;
  }

  device(id: string): Device | undefined {
    return readEntity<Device>(this.store, "devices", id);
  }
}
