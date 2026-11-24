import React from "react";
import { AgentList, Placeholder } from "../../src/components/lists";
import { Split } from "../../src/layout/Shell";

export default function AgentsTab() {
  return <Split show="list" list={<AgentList />} detail={<Placeholder icon="cpu" title="Pick an agent or a run" body="Agents live on your connectors. Start a run, watch its timeline, cancel it." />} />;
}
