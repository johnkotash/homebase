import React from "react";
import { InboxList, Placeholder } from "../../src/components/lists";
import { Split } from "../../src/layout/Shell";

export default function InboxTab() {
  return <Split show="list" list={<InboxList />} detail={<Placeholder icon="inbox" title="Pick an item" body="Everything that needs you, in priority order, each on its SLA clock." />} />;
}
