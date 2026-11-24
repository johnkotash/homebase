import { create } from "zustand";
import type { SessionFilter, SessionScope, SessionSort } from "@homebase/protocol";

/**
 * How the session list is being looked at: which project (or All, or Unsorted), the filter, the sort
 * and the search text. Kept outside the list so it survives going into a session and back, and so the
 * list beside an open session (wide layouts) shows the same thing the owner chose. Per device, not synced.
 */
interface SessionView {
  scope: SessionScope;
  filter: SessionFilter;
  sort: SessionSort;
  query: string;
}

export const useSessionView = create<SessionView>(() => ({ scope: "all", filter: "open", sort: "recent", query: "" }));
export const setSessionView = (patch: Partial<SessionView>) => useSessionView.setState(patch);
