import React from "react";
import { Placeholder } from "../../src/components/lists";
import { ProjectList } from "../../src/components/projects";
import { Split } from "../../src/layout/Shell";

/** The Projects tab: one tap to a project's sessions, agents and recent activity. */
export default function ProjectsTab() {
  return <Split show="list" list={<ProjectList />} detail={<Placeholder icon="folder" title="Pick a project" body="A project keeps the sessions, the agents and the recent activity of one piece of work together." />} />;
}
