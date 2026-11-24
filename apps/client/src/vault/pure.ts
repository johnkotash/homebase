import type { VaultFile } from "@homebase/protocol";

/** Pure helpers for the Notes tab: today in the owner's zone, the folder tree, and small labels. Unit-tested. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const deviceTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export interface Today {
  /** YYYYMMDD in the owner's time zone. */
  ymd: string;
  /** "Thu 19 Nov" */
  label: string;
  /** The general daily log for this month. */
  path: string;
  monthTitle: string;
}

/** Today in the vault's time zone (the owner's), falling back to this device's. */
export function todayIn(tz: string | undefined, now: number): Today {
  let parts: Record<string, string> = {};
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz ?? deviceTz(), year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  } catch {
    const d = new Date(now);
    parts = { year: String(d.getFullYear()), month: String(d.getMonth() + 1).padStart(2, "0"), day: String(d.getDate()).padStart(2, "0"), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] };
  }
  const month = MONTHS[Number(parts.month) - 1];
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`, label: `${parts.weekday} ${Number(parts.day)} ${month.slice(0, 3)}`,
    path: `Daily Notes/${parts.year}/${month}.md`, monthTitle: `${month} ${parts.year}`,
  };
}

/** Does this read like a question for the agent rather than something to file? */
export const looksLikeQuestion = (text: string) =>
  /^\s*(what|when|where|who|why|how|which|did|do|does|is|are|was|were|can|could|summari[sz]e|find|search|show|list|tell me|remind me what|look up)\b/i.test(text) || /\?\s*$/.test(text.trim());

// ---------------------------------------------------------------- the folder tree

export interface TreeNode {
  name: string;
  path: string;
  folders: TreeNode[];
  files: VaultFile[];
  count: number;
}

const monthIdx = (name: string) => MONTHS.indexOf(name.replace(/\.md$/i, ""));

export function buildTree(files: VaultFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.folders.find((x) => x.name === parts[i]);
      if (!next) node.folders.push((next = { name: parts[i], path, folders: [], files: [], count: 0 }));
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  const sort = (n: TreeNode) => {
    // Old versions sit at the bottom; everything else is alphabetical.
    n.folders.sort((a, b) => Number(a.name === "_Archive") - Number(b.name === "_Archive") || a.name.localeCompare(b.name));
    n.files.sort((a, b) => {
      const [ma, mb] = [monthIdx(a.path.split("/").pop()!), monthIdx(b.path.split("/").pop()!)];
      return ma >= 0 && mb >= 0 ? ma - mb : a.path.localeCompare(b.path);
    });
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** A small label for folders with special rules. */
export function folderLabel(path: string): string | null {
  if (path === "Daily Notes/RAW") return "yours only";
  if (path === "Daily Notes/RAW/AI Transcriptions") return "transcripts";
  if (path === "_Archive") return "old versions";
  return null;
}

export const fileName = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

/** A note's name for a list: its title, with the client or year when the title alone would be ambiguous. */
export function displayTitle(f: Pick<VaultFile, "path" | "title">): string {
  return f.title || fileName(f.path);
}

