import React from "react";
import { DesktopConnectionForm } from "../src/components/DesktopConnection";
import { Card, Empty } from "../src/components/ui";
import { useDesktopConnection } from "../src/desktop/connection";
import { Header, Screen } from "../src/layout/Shell";
import { useSession } from "../src/sync/session";

/** Settings → Desktop connection, and "Change" on the desktop pair screen. Desktop app only. */
export default function ConnectionScreen() {
  const snap = useDesktopConnection((s) => s.snap);
  const paired = useSession((s) => !!s.session);
  return (
    <Screen maxWidth={620}>
      <Header title="Desktop connection" subtitle="How this PC reaches the hub" back={paired ? "/settings" : "/pair"} />
      {snap ? (
        <Card><DesktopConnectionForm /></Card>
      ) : (
        <Empty icon="monitor" title="Desktop app only" body="The phone and the browser connect to the hub's address directly." />
      )}
    </Screen>
  );
}
