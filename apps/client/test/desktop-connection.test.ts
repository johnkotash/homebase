import { describe, expect, it } from "vitest";
import { connectedHubUrl, connectionHeadline, defaultHubUrl, formErrors, targetLabel, type ConnSnapshot, type ConnState } from "../src/desktop/connectionRules";

const config = { mode: "ssh" as const, sshHost: "homebase-server", remotePort: 8787, localPort: 18787, directUrl: "" };
const snap = (state: Partial<ConnState>, extra: Partial<ConnSnapshot> = {}): ConnSnapshot => ({
  config, configured: true, state: { phase: "idle", attempt: 1, since: 0, ...state }, ...extra,
});

describe("desktop connection, as the page sees it", () => {
  it("has a hub address only while connected", () => {
    expect(connectedHubUrl({ phase: "connected", url: "http://127.0.0.1:18787", attempt: 1, since: 0 })).toBe("http://127.0.0.1:18787");
    expect(connectedHubUrl({ phase: "retrying", url: "http://127.0.0.1:18787", attempt: 1, since: 0 })).toBeNull();
    expect(connectedHubUrl(null)).toBeNull();
  });

  it("says where it is going", () => {
    expect(targetLabel(config)).toBe("homebase-server over SSH");
    expect(targetLabel({ ...config, mode: "direct", directUrl: "http://100.101.102.103:8787" })).toBe("http://100.101.102.103:8787");
  });

  it("headlines each state, with the shell's own words for errors", () => {
    expect(connectionHeadline(snap({ phase: "connected", url: "http://127.0.0.1:18787", localPort: 18787 }), 0))
      .toMatchObject({ tone: "ok", title: "Connected to homebase-server over SSH", body: "Tunnel on this PC: 127.0.0.1:18787 → homebase-server:8787" });
    expect(connectionHeadline(snap({ phase: "connecting" }), 0)).toMatchObject({ tone: "muted", busy: true, title: "Opening the SSH tunnel to homebase-server…" });
    expect(connectionHeadline(snap({ phase: "connecting", error: { code: "hub_unreachable", message: "hub down" } }), 0)).toMatchObject({ tone: "warn", title: "The hub is not answering", body: "hub down" });
    expect(connectionHeadline(snap({ phase: "retrying", retryAt: 5000, error: { code: "unreachable", message: "Can't reach homebase-server" } }), 1200))
      .toMatchObject({ tone: "warn", title: "Can't connect · trying again in 4s", body: "Can't reach homebase-server" });
    expect(connectionHeadline(snap({ phase: "error", error: { code: "auth", message: "key refused" } }), 0)).toMatchObject({ tone: "danger", title: "SSH key not accepted" });
    expect(connectionHeadline(snap({ phase: "error", error: { code: "ssh_missing", message: "x" } }), 0).title).toBe("SSH is not installed on this PC");
    expect(connectionHeadline(snap({ phase: "error", error: { code: "host_key", message: "x" } }), 0).title).toBe("Host key not trusted yet");
  });

  it("checks the form before the shell does", () => {
    expect(formErrors({ mode: "ssh", sshHost: "homebase-server", directUrl: "", remotePort: "8787" })).toEqual({});
    expect(formErrors({ mode: "ssh", sshHost: "-oProxyCommand=calc", directUrl: "", remotePort: "8787" }).sshHost).toBeTruthy();
    expect(formErrors({ mode: "ssh", sshHost: "homebase-server", directUrl: "", remotePort: "99999" }).remotePort).toBeTruthy();
    expect(formErrors({ mode: "direct", sshHost: "", directUrl: "http://100.101.102.103:8787", remotePort: "" })).toEqual({});
    expect(formErrors({ mode: "direct", sshHost: "", directUrl: "100.101.102.103:8787", remotePort: "" }).directUrl).toBeTruthy();
    expect(formErrors({ mode: "direct", sshHost: "", directUrl: "http://x/v1", remotePort: "" }).directUrl).toBeTruthy();
  });

  it("a web build served by the hub pairs with the address it was opened from", () => {
    const loc = { protocol: "http:", origin: "http://100.101.102.103:8787" };
    expect(defaultHubUrl({ platform: "web", production: true, location: loc, envUrl: "http://localhost:8789" })).toBe("http://100.101.102.103:8787");
    // the dev server keeps the baked-in or local address
    expect(defaultHubUrl({ platform: "web", production: false, location: { protocol: "http:", origin: "http://localhost:8081" } })).toBe("http://localhost:8787");
    // the desktop app's app:// page is not a hub address
    expect(defaultHubUrl({ platform: "web", production: true, location: { protocol: "app:", origin: "app://homebase" } })).toBe("http://localhost:8787");
    expect(defaultHubUrl({ platform: "android", production: true, envUrl: "http://100.101.102.103:8787" })).toBe("http://100.101.102.103:8787");
    expect(defaultHubUrl({ platform: "android", production: false })).toBe("http://10.0.2.2:8787");
  });
});
