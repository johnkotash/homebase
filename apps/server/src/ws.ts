import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { HelloFrame, InboundFrame } from "@homebase/protocol";
import type { Directory } from "./directory";
import { browserDebug } from "./hub/browser";
import type { Peer, WorkspaceHub } from "./hub/WorkspaceHub";

export const HELLO_TIMEOUT_MS = 5000;

/** WebSocket gateway: authenticates `hello`, then hands the socket to the workspace hub with a role. */
export function attachWebSocket(servers: Server | Server[], hub: WorkspaceHub, directory: Directory, opts: { helloTimeoutMs?: number } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  for (const server of Array.isArray(servers) ? servers : [servers]) server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/v1/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    let peer: Peer | null = null;
    const send = (frame: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const timer = setTimeout(() => {
      if (!peer) {
        send({ t: "error", code: "hello_timeout", message: "No hello frame received" });
        ws.close(4001, "hello timeout");
      }
    }, opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send({ t: "error", code: "bad_json", message: "Frames must be JSON objects" });
        return;
      }
      if (!peer) {
        const hello = HelloFrame.safeParse(json);
        if (!hello.success) {
          send({ t: "error", code: "bad_hello", message: "The first frame must be a valid hello" });
          ws.close(4002, "bad hello");
          return;
        }
        const device = directory.authenticate(hello.data.token);
        if (!device || device.kind !== hello.data.role) {
          send({ t: "error", code: "unauthorized", message: "Unknown or revoked token" });
          ws.close(4003, "unauthorized");
          return;
        }
        clearTimeout(timer);
        peer = {
          id: device.id, role: device.kind, name: hello.data.client?.name ?? device.name, canApprove: device.canApprove,
          topics: new Set(), send, close: (code, reason) => ws.close(code, reason),
        };
        if (peer.role === "device") hub.attachDevice(peer, hello.data);
        else hub.attachConnector(peer);
        return;
      }
      const frame = InboundFrame.safeParse(json);
      if (!frame.success) {
        const t = (json as { t?: unknown })?.t;
        if (browserDebug() && typeof t === "string" && t.startsWith("browser.")) {
          console.log(`[hub] browser debug: refused ${t}: ${frame.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
        send({ t: "error", code: "bad_frame", message: frame.error.issues[0]?.message ?? "Invalid frame" });
        return;
      }
      try {
        hub.onFrame(peer, frame.data);
      } catch (err) {
        console.error("[hub] frame handler failed", err);
        send({ t: "error", code: "internal", message: "The hub could not process that frame" });
      }
    });

    ws.on("close", () => {
      clearTimeout(timer);
      if (peer) hub.detach(peer);
    });
    ws.on("error", () => ws.close());
  });

  return wss;
}
