import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import type { BrowserState, BrowserToDevice } from "@homebase/protocol";
import { BROWSER_DEBUG, bdbg } from "./browserDebug";
import { browserAck, refreshBrowser, showToast, watchBrowser } from "./sync/session";

const frameStats: Record<string, { n: number; bytes: number; since: number; w: number; h: number; lagSum: number }> = {};

/**
 * A connector's browser as this device sees it right now: its state and its latest picture. Held in
 * memory only while some screen is watching, and dropped when the last one stops. Nothing is cached.
 */

export interface LivePicture {
  uri: string;
  width: number;
  height: number;
  seq: number;
}

export interface LiveBrowser {
  /** The hub has answered: `state` is what it knows (null when the machine with the browser is offline). */
  known: boolean;
  state: BrowserState | null;
  picture: LivePicture | null;
  /** When the last few pictures arrived, by this device's clock: the connection indicator counts them. */
  arrivals: number[];
  /** How long a picture takes to come and be acknowledged, as the browser node last measured it (ms). Null until it has. */
  rtt: number | null;
  /** The picture level the node chose for this link (0 sharpest). */
  level: number | null;
}

const EMPTY: LiveBrowser = { known: false, state: null, picture: null, arrivals: [], rtt: null, level: null };
const useLive = create<Record<string, LiveBrowser>>(() => ({}));
const watchers = new Map<string, { count: number; stop: () => void }>();

function onMessage(connectorId: string, m: BrowserToDevice) {
  const cur = useLive.getState()[connectorId] ?? EMPTY;
  if (m.t === "browser.state") {
    // A browser that closed, or went private, shows no stale picture.
    const keep = m.state?.running ? cur.picture : null;
    useLive.setState({ [connectorId]: { ...cur, known: true, state: m.state, picture: keep, arrivals: keep ? cur.arrivals : [] } });
  } else if (m.t === "browser.frame") {
    // Acknowledged on arrival: the node sends the next picture when this one is here, so a slow link is never flooded.
    browserAck(connectorId, m.frame.seq);
    const arrivals = [...cur.arrivals.slice(-14), Date.now()];
    if (BROWSER_DEBUG) {
      const s = (frameStats[connectorId] ??= { n: 0, bytes: 0, since: Date.now(), w: 0, h: 0, lagSum: 0 });
      s.n++;
      s.bytes += Math.round(m.frame.data.length * 0.75);
      s.w = m.frame.width;
      s.h = m.frame.height;
      s.lagSum += Date.now() - m.frame.at;
      if (Date.now() - s.since >= 5000) {
        const secs = (Date.now() - s.since) / 1000;
        bdbg("frames", { fps: +(s.n / secs).toFixed(1), avgKB: Math.round(s.bytes / s.n / 1024), kbps: Math.round((s.bytes * 8) / 1024 / secs), size: `${s.w}x${s.h}`, avgAgeMs: Math.round(s.lagSum / s.n), rtt: m.frame.rtt ?? null, level: m.frame.level ?? null, seq: m.frame.seq });
        frameStats[connectorId] = { n: 0, bytes: 0, since: Date.now(), w: 0, h: 0, lagSum: 0 };
      }
    }
    useLive.setState({ [connectorId]: {
      ...cur, arrivals, rtt: m.frame.rtt ?? cur.rtt, level: m.frame.level ?? cur.level,
      picture: { uri: `data:image/jpeg;base64,${m.frame.data}`, width: m.frame.width, height: m.frame.height, seq: m.frame.seq },
    } });
  } else if (m.t === "browser.notice") {
    bdbg("notice", m.message);
    showToast("Browser", m.message);
  }
}

/**
 * The app back in front after a while in the background: what it knew about each watched browser may be stale
 * (the owner's seat may have gone back to the agent meanwhile). It is forgotten until the hub answers again, so
 * no screen acts on an old "you drive".
 */
let appState = AppState.currentState;
function watchAppState() {
  if (Platform.OS === "web" || (watchAppState as { on?: boolean }).on) return;
  (watchAppState as { on?: boolean }).on = true;
  AppState.addEventListener("change", (next) => {
    const back = next === "active" && appState !== "active";
    appState = next;
    if (!back) return;
    for (const connectorId of watchers.keys()) {
      const cur = useLive.getState()[connectorId];
      if (cur) useLive.setState({ [connectorId]: { ...cur, known: false } });
      refreshBrowser(connectorId);
    }
  });
}

/** Watches the browser on a connector while the calling screen is mounted (and `on` is true). */
export function useBrowser(connectorId: string | null | undefined, on = true): LiveBrowser {
  useEffect(() => {
    if (!connectorId || !on) return;
    watchAppState();
    let w = watchers.get(connectorId);
    if (!w) {
      w = { count: 0, stop: watchBrowser(connectorId, (m) => onMessage(connectorId, m)) };
      watchers.set(connectorId, w);
    }
    w.count++;
    return () => {
      const cur = watchers.get(connectorId);
      if (!cur) return;
      if (--cur.count > 0) return;
      cur.stop();
      watchers.delete(connectorId);
      useLive.setState({ [connectorId]: EMPTY });
    };
  }, [connectorId, on]);
  return useLive((s) => (connectorId ? s[connectorId] : undefined)) ?? EMPTY;
}
