import React from "react";
import { Placeholder } from "../../src/components/lists";
import { SessionList } from "../../src/components/sessions";
import { Split } from "../../src/layout/Shell";

/** The Sessions tab: every chat with an agent, by project, with search. The route keeps its old name so links still work. */
export default function ChatsTab() {
  return <Split show="list" list={<SessionList />} detail={<Placeholder icon="message-square" title="Pick a session" body="Talk to an agent by text or voice. A session continues where you left it, on every device." />} />;
}
