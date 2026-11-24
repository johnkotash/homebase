import React from "react";
import { Placeholder } from "../../src/components/lists";
import { NotesHome } from "../../src/components/NotesHome";
import { Split } from "../../src/layout/Shell";

/** The Notes tab is the Obsidian vault: Today, Recent, Browse and Search on the left, the note on the right when there is room. */
export default function NotesTab() {
  return <Split show="list" list={<NotesHome />} detail={<Placeholder icon="book-open" title="Pick a note" body="Notes are read from your vault. Dictate into today's note with the mic, or ask the Notes agent." />} />;
}
