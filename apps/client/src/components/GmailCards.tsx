import React from "react";
import { StyleSheet, View } from "react-native";
import type { GmailCard } from "@homebase/protocol";
import type { EmailView } from "../gmail";
import { color, radius, space } from "../theme";
import { Card, Icon, T, Tag } from "./ui";

function Line({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={st.line} accessibilityLabel={`${label}: ${value}`}>
      <T v="micro" style={st.label}>{label}</T>
      <T selectable style={{ flex: 1, fontSize: 14, lineHeight: 20 }} tone={warn ? color.warn : color.text}>{value}</T>
    </View>
  );
}

/** From, To, Cc, Bcc, Subject and the text of an email, laid out the same way wherever one is shown. */
export function EmailFields({ email, maxBodyLines }: { email: EmailView; maxBodyLines?: number }) {
  const isNew = (a: string) => email.newRecipients.includes(a);
  const who = (l: string[]) => l.map((a) => (isNew(a) ? `${a} (new)` : a)).join(", ");
  return (
    <View style={{ gap: space.sm }} testID="email-fields">
      <View style={st.fields}>
        {email.from ? <Line label="From" value={email.from} /> : null}
        <Line label="To" value={who(email.to) || "(none)"} warn={email.to.some(isNew)} />
        {email.cc.length ? <Line label="Cc" value={who(email.cc)} warn={email.cc.some(isNew)} /> : null}
        {email.bcc.length ? <Line label="Bcc" value={who(email.bcc)} warn /> : null}
        <Line label="Subject" value={email.subject || "(no subject)"} />
        {email.attachments.length ? <Line label="Files" value={email.attachments.join(", ")} /> : null}
      </View>
      {email.newRecipients.length ? (
        <View style={st.flag} accessibilityLabel="New recipient warning">
          <Icon name="alert-triangle" size={14} tone={color.warn} />
          <T v="small" tone={color.warn} style={{ flex: 1 }}>
            {email.isReply
              ? `Not on this thread before: ${email.newRecipients.join(", ")}`
              : "New conversation: nobody on this email has been written to in this thread before."}
          </T>
        </View>
      ) : null}
      <View style={st.body}><T selectable numberOfLines={maxBodyLines} style={{ lineHeight: 22 }}>{email.body || "(empty)"}</T></View>
      {email.capNote ? <T v="small" muted>{email.capNote}</T> : null}
    </View>
  );
}

/** A draft the Comms agent saved (or an email the owner approved), shown in the chat. */
export function GmailDraftCard({ card }: { card: GmailCard }) {
  const sent = card.type === "gmail_sent";
  const email: EmailView = { from: null, to: card.to, cc: card.cc, bcc: card.bcc, subject: card.subject, body: card.body, newRecipients: [], isReply: !!card.threadId, attachments: [], capNote: null };
  return (
    <Card pad={space.md} style={{ gap: space.sm, maxWidth: 560, width: "100%" }}>
      <View style={st.head}>
        <Icon name={sent ? "send" : "file-text"} size={16} tone={color.text} />
        <T v="heading" style={{ flex: 1, fontSize: 15 }}>{sent ? "Email sent" : card.updated ? "Draft updated in Gmail" : "Draft saved in Gmail"}</T>
        <Tag label={sent ? "SENT" : "NOT SENT"} tone={sent ? color.ok : color.textDim} icon={sent ? "check" : "edit-3"} />
      </View>
      <EmailFields email={email} />
      {sent ? null : <T v="small" muted>It is in your Gmail Drafts folder. Ask the agent to change it, or to send it; sending always asks you first.</T>}
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  fields: { borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg, paddingHorizontal: space.md, paddingVertical: 4 },
  line: { flexDirection: "row", gap: space.md, paddingVertical: 7, alignItems: "flex-start", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  label: { width: 58, paddingTop: 3 },
  body: { borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg, padding: space.md },
  flag: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingHorizontal: 2 },
});
