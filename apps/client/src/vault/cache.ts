import { cacheStorage } from "../sync/storage";

/**
 * Note bodies kept on this device for offline reading (NOTES-PLAN.md 7.3): the last 50 notes opened,
 * in app-private storage. Nothing is cached ahead of time, and "Clear cached notes" or unpairing removes it all.
 */
export interface NoteBody {
  path: string;
  title: string;
  text: string;
  hash: string;
  mtime: number;
  totalLines: number;
  truncated: boolean;
  cls: string;
  /** When this copy was fetched. */
  at: number;
}

const INDEX_KEY = "hb.vault.cache.index";
const noteKey = (path: string) => `hb.vault.note:${path}`;
const MAX_CACHED = 50;
/** Described in the vault's rules as credentials-adjacent: readable, but never kept on a device (NOTES-PLAN.md 7.5). */
// Any folder named "Client Notes", "Private" or "Secrets", at any depth.
const NEVER_CACHE = /(^|\/)(Client Notes|Private|Secrets)\//i;

async function cacheIndex(): Promise<Array<{ path: string; at: number }>> {
  try {
    const raw = await cacheStorage.getItem(INDEX_KEY);
    const j = raw ? JSON.parse(raw) : [];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

export async function cacheGet(path: string): Promise<NoteBody | null> {
  try {
    const raw = await cacheStorage.getItem(noteKey(path));
    return raw ? (JSON.parse(raw) as NoteBody) : null;
  } catch {
    return null;
  }
}

export async function cachePut(note: NoteBody) {
  if (NEVER_CACHE.test(note.path) || note.truncated) return;
  try {
    await cacheStorage.setItem(noteKey(note.path), JSON.stringify(note));
    const index = (await cacheIndex()).filter((e) => e.path !== note.path);
    index.unshift({ path: note.path, at: note.at });
    for (const old of index.splice(MAX_CACHED)) await cacheStorage.removeItem(noteKey(old.path));
    await cacheStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // a full or unavailable store only costs offline reading
  }
}

/** Removes every cached note body from this device. Metadata comes back with the next sync. */
export async function clearNoteCache(): Promise<number> {
  const index = await cacheIndex();
  for (const e of index) await cacheStorage.removeItem(noteKey(e.path)).catch(() => {});
  await cacheStorage.removeItem(INDEX_KEY).catch(() => {});
  return index.length;
}

