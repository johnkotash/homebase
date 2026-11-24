import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { KeyValueStore } from "@homebase/sync-client";

/** Cache and outbox. AsyncStorage on native, localStorage on web/Electron (same API through the package). */
export const cacheStorage: KeyValueStore = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

const SESSION_KEY = "homebase.session";

export interface Session {
  url: string;
  token: string;
  deviceId: string;
  workspaceId: string;
  name: string;
}

/**
 * The device token is the only credential this app holds. Keystore/Keychain on native.
 * Web/Electron use localStorage in the prototype (ARCHITECTURE.md 9.2; Electron moves to safeStorage at MVP).
 */
export const sessionStorage = {
  async load(): Promise<Session | null> {
    try {
      const raw = Platform.OS === "web" ? globalThis.localStorage?.getItem(SESSION_KEY) : await SecureStore.getItemAsync(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  },
  async save(s: Session) {
    const raw = JSON.stringify(s);
    if (Platform.OS === "web") globalThis.localStorage?.setItem(SESSION_KEY, raw);
    else await SecureStore.setItemAsync(SESSION_KEY, raw);
  },
  async clear() {
    if (Platform.OS === "web") globalThis.localStorage?.removeItem(SESSION_KEY);
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};
