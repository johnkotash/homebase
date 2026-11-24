import React from "react";
import { ApprovalsList, Placeholder } from "../../src/components/lists";
import { Split } from "../../src/layout/Shell";

export default function ApprovalsScreen() {
  return <Split show="list" list={<ApprovalsList />} detail={<Placeholder icon="shield" title="Pick an approval" body="Agents stay paused until you approve or deny. Nothing is ever auto-approved." />} />;
}
