import type { EntityName } from "@homebase/protocol";
import type { SqlStore, SqlValue } from "./SqlStore";

interface TableDef {
  table: string;
  /** camelCase entity fields that map to snake_case columns */
  fields: string[];
  json?: string[];
  bool?: string[];
}

export const TABLES: Record<EntityName, TableDef> = {
  workspace: { table: "workspaces", fields: ["id", "name", "timezone", "plan", "createdAt"] },
  devices: {
    table: "devices",
    fields: ["id", "kind", "name", "platform", "canApprove", "online", "lastSeenAt", "revokedAt", "createdAt"],
    bool: ["canApprove", "online"],
  },
  connectors: { table: "connectors", fields: ["id", "name", "host", "status", "lastSeenAt"], json: ["host"] },
  agents: {
    table: "agents",
    fields: ["id", "connectorId", "key", "name", "kind", "description", "capabilities", "workspaces", "permissionProfile", "status", "updatedAt", "statusNote",
      "modes", "defaultMode", "auth", "gmail", "vault", "models", "efforts", "configModel", "configEffort", "defaultModel", "defaultEffort", "images", "folders", "defaultCwd", "defaultFolders"],
    json: ["capabilities", "workspaces", "modes", "auth", "gmail", "vault", "models", "efforts", "images", "folders", "defaultFolders"],
  },
  threads: {
    table: "threads",
    fields: ["id", "title", "agentId", "lastMessageAt", "pinned", "archived", "createdBy", "createdAt", "updatedAt", "mode",
      "projectId", "note", "summary", "recap", "recapAt", "recapRunId", "lastRunStatus", "lastAgentAt", "readAt", "model", "effort", "sessionResetAt", "imageRoute", "cwd", "folders"],
    json: ["folders"],
    bool: ["pinned", "archived"],
  },
  messages: { table: "messages", fields: ["id", "threadId", "role", "text", "source", "runId", "authorDeviceId", "createdAt", "card", "attachments"], json: ["card", "attachments"] },
  runs: {
    table: "runs",
    fields: ["id", "agentId", "threadId", "prompt", "status", "sessionRef", "summary", "error", "costUsd", "numTurns", "durationMs",
      "lastEventIdx", "startedBy", "cwd", "createdAt", "startedAt", "endedAt", "updatedAt", "mode", "model", "effort", "folders"],
    json: ["folders"],
  },
  approvals: {
    table: "approvals",
    fields: ["id", "runId", "agentId", "kind", "tool", "title", "summary", "input", "questions", "risk", "reason", "status",
      "decisionMessage", "answers", "decidedBy", "requestedAt", "decidedAt", "mode"],
    json: ["input", "questions", "answers"],
  },
  inbox_items: {
    table: "inbox_items",
    fields: ["id", "source", "externalId", "externalUrl", "title", "snippet", "body", "sender", "clientLabel", "priority", "status",
      "triageReason", "assignedAgentId", "linkedThreadId", "linkedRunId", "slaPolicyId", "slaDueAt", "slaWarnAt", "slaState",
      "respondedAt", "snoozeUntil", "receivedAt", "createdAt", "updatedAt"],
  },
  notes: {
    table: "notes",
    fields: ["id", "title", "body", "tags", "rev", "source", "vaultPath", "createdAt", "updatedAt"],
    json: ["tags"],
  },
  integrations: { table: "integrations", fields: ["id", "kind", "name", "status", "config", "lastSyncAt", "error"], json: ["config"] },
  sla_policies: {
    table: "sla_policies",
    fields: ["id", "name", "match", "respondWithinMinutes", "warnAtPct", "calendar", "isDefault", "updatedAt"],
    json: ["match", "calendar"],
    bool: ["isDefault"],
  },
  settings: { table: "settings", fields: ["id", "value", "updatedAt"], json: ["value"] },
  vault_files: { table: "vault_files", fields: ["id", "path", "title", "type", "tags", "summary", "mtime", "size", "hash", "folder"], json: ["tags"] },
  projects: {
    table: "projects",
    fields: ["id", "name", "description", "defaultAgentId", "defaultCwd", "pinned", "archived", "createdAt", "updatedAt", "imageRoute", "folders"],
    json: ["folders"],
    bool: ["pinned", "archived"],
  },
};

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const COLS = new Map<EntityName, string[]>();
for (const [name, def] of Object.entries(TABLES)) COLS.set(name as EntityName, def.fields.map(snake));

export function rowToEntity<T = any>(entity: EntityName, row: Record<string, SqlValue> | undefined): T | undefined {
  if (!row) return undefined;
  const def = TABLES[entity];
  const cols = COLS.get(entity)!;
  const out: Record<string, unknown> = {};
  def.fields.forEach((f, i) => {
    let v: unknown = row[cols[i]];
    if (v === undefined) v = null;
    if (def.json?.includes(f)) v = v == null ? null : JSON.parse(v as string);
    else if (def.bool?.includes(f)) v = !!v;
    out[f] = v;
  });
  return out as T;
}

export function readEntity<T = any>(store: SqlStore, entity: EntityName, id: string): T | undefined {
  const def = TABLES[entity];
  return rowToEntity<T>(entity, store.get(`SELECT * FROM ${def.table} WHERE id = ?`, id));
}

export function queryEntities<T = any>(store: SqlStore, entity: EntityName, where = "", ...params: SqlValue[]): T[] {
  const def = TABLES[entity];
  return store.all<Record<string, SqlValue>>(`SELECT * FROM ${def.table} ${where}`, ...params).map((r) => rowToEntity<T>(entity, r)!);
}

export function writeEntity(store: SqlStore, entity: EntityName, obj: Record<string, unknown>): void {
  const def = TABLES[entity];
  const cols = COLS.get(entity)!;
  const values: SqlValue[] = def.fields.map((f) => {
    const v = obj[f];
    if (v === undefined || v === null) return null;
    if (def.json?.includes(f)) return JSON.stringify(v);
    if (def.bool?.includes(f)) return v ? 1 : 0;
    return v as SqlValue;
  });
  const updates = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
  store.run(
    `INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    ...values,
  );
}

export function deleteEntity(store: SqlStore, entity: EntityName, id: string): void {
  store.run(`DELETE FROM ${TABLES[entity].table} WHERE id = ?`, id);
}
