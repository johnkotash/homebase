import { useLocalSearchParams } from "expo-router";
import React from "react";
import { ProjectDetail, ProjectList } from "../../src/components/projects";
import { Split } from "../../src/layout/Shell";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<ProjectList selectedId={id} />} detail={<ProjectDetail id={id} key={id} />} />;
}
