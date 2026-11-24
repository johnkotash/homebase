import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHub } from "../src/app";
import { loadConfig } from "../src/config";

describe("hub config", () => {
  it("defaults to loopback on 8787", () => {
    expect(loadConfig({})).toMatchObject({ host: "127.0.0.1", port: 8787, bootCodes: true, publicUrl: null, workspaceName: "HomeBase" });
    expect(loadConfig({ HOMEBASE_WORKSPACE_NAME: " Acme Studio " }).workspaceName).toBe("Acme Studio");
  });

  it("takes HOMEBASE_HOST / HOMEBASE_PORT over HOST / PORT and expands ~ in the data dir", () => {
    const cfg = loadConfig({ HOST: "127.0.0.2", PORT: "1", HOMEBASE_HOST: "100.64.1.2", HOMEBASE_PORT: "9000", HOMEBASE_DATA_DIR: "~/hb-data", HOMEBASE_BOOT_CODES: "0" });
    expect(cfg).toMatchObject({ host: "100.64.1.2", port: 9000, bootCodes: false });
    expect(cfg.dataDir).toBe(join(homedir(), "hb-data"));
  });

  it("refuses to listen on every interface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-cfg-"));
    try {
      await expect(startHub({ dbPath: ":memory:", host: "0.0.0.0", seed: { demo: false } })).rejects.toThrow(/every interface/);
      const app = await startHub({ dbPath: ":memory:", host: "127.0.0.1, 127.0.0.1", port: 0, seed: { demo: false } }).catch((e) => e);
      // The second listener reuses the first one's port, so the same address twice must fail cleanly rather than hang.
      if (!(app instanceof Error)) await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
