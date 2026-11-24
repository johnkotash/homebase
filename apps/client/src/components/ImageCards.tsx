import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { Image, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import {
  IMAGE_ACTIONS, IMAGE_CHECK_SETTING, IMAGE_ROUTES, MAKER_LABEL, ROUTE_BLURB, ROUTE_LABEL, ROUTE_TITLE, newId, resolveImageRoute,
  type Agent, type GeneratedImageCard, type ImageIssueCard, type ImageMaker, type ImageRoute, type Project, type Thread,
} from "@homebase/protocol";
import { imageAspect, imageByline, imageMeta, imagesChip, openaiLine, projectImages, shownArtifact } from "../images";
import { useMap, useSetting } from "../sync/hooks";
import { mutate, useSession } from "../sync/session";
import { color, radius, space } from "../theme";
import { Field, Sheet } from "./Sheet";
import { Btn, Card, Icon, T, Toggle } from "./ui";

/**
 * Images made in a session, the same on the phone and the desktop: the card for a finished image (with
 * the provider that made it at the top), the card for one that was not made, the chip above the message
 * box that says who makes images here, and a project's grid of everything made in it.
 *
 * The app stays black and white. Who made a thing is said in words and a glyph, never by a colour.
 */

/** A provider's name as a small solid label. The same shape wherever something is attributed. */
export function MakerMark({ maker, small }: { maker: ImageMaker; small?: boolean }) {
  return (
    <View style={[st.mark, small && st.markSmall]} accessibilityLabel={`Made by ${MAKER_LABEL[maker]}`} testID={`maker-${maker}`}>
      <Icon name={maker === "openai" ? "aperture" : "pen-tool"} size={small ? 10 : 12} tone={color.accentInk} />
      <T style={[st.markText, small && { fontSize: 10 }]}>{MAKER_LABEL[maker].toUpperCase()}</T>
    </View>
  );
}

/**
 * In a browser an <img> cannot send a header, so the bytes are fetched with the token in the Authorization
 * header and shown from an object URL. An artifact never changes, so each one is fetched once per page.
 */
const blobUrls = new Map<string, Promise<string>>();
function loadBlobUrl(base: string, token: string, path: string): Promise<string> {
  const key = `${base}|${path}`;
  let p = blobUrls.get(key);
  if (!p) {
    p = fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (res) => {
      if (!res.ok) throw new Error(`Hub answered ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    blobUrls.set(key, p);
    p.catch(() => blobUrls.delete(key)); // a failure is not remembered: the next mount tries again
  }
  return p;
}

/**
 * What <Image> should load for a hub file (`/v1/artifacts/:id`, `/v1/attachments/:id`): the hub address with the
 * token header on the phone, an object URL in a browser. `local` is a copy this device already has (a picture it
 * just attached): shown at once, no fetch.
 */
export function useHubSource(path: string, local?: string | null): { source: { uri: string; headers?: Record<string, string> } | null; failed: boolean; fail(): void } {
  const session = useSession((s) => s.session);
  const [blob, setBlob] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const web = Platform.OS === "web";
  useEffect(() => {
    setFailed(false);
    setBlob(null);
    if (!web || !session || local) return;
    let live = true;
    loadBlobUrl(session.url, session.token, path).then((u) => live && setBlob(u), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [web, session?.url, session?.token, path, local]);
  const source = local ? { uri: local } : !session ? null : web ? (blob ? { uri: blob } : null) : { uri: `${session.url}${path}`, headers: { Authorization: `Bearer ${session.token}` } };
  return { source, failed, fail: () => setFailed(true) };
}
const useArtifactSource = (id: string) => useHubSource(`/v1/artifacts/${id}`);

/** The picture itself, fetched from the hub with this device's token in the header (never in the address). */
export function ArtifactImage({ card, style, contain }: { card: Pick<GeneratedImageCard, "artifactId" | "previewId" | "mime" | "name" | "width" | "height">; style?: any; contain?: boolean }) {
  const paired = useSession((s) => !!s.session);
  const { source, failed, fail } = useArtifactSource(shownArtifact(card));
  // An SVG with no PNG preview can only be drawn by a browser.
  const undrawable = card.mime === "image/svg+xml" && !card.previewId && Platform.OS !== "web";
  if (!paired || failed || undrawable) {
    return (
      <View style={[st.missing, style]}>
        <Icon name="image" size={22} tone={color.textMuted} />
        <T v="small" muted style={{ textAlign: "center" }}>{undrawable ? "An SVG. Open it on the desktop to see it." : failed ? "The picture could not be loaded from the hub. The file is on the connector machine." : "Not paired"}</T>
      </View>
    );
  }
  // Still fetching (browser): hold the picture's place so the conversation does not jump when it arrives.
  if (!source) return <View style={[st.loading, style]} testID="artifact-loading" />;
  return <Image source={source} style={style} resizeMode={contain ? "contain" : "cover"} accessibilityLabel={card.name} onError={fail} testID="artifact-image" />;
}

/** A finished image in the conversation: who made it, the picture, what was asked, where it was saved, and what to do next. */
export function GeneratedImageCardView({ card, threadId, actions = true }: { card: GeneratedImageCard; threadId?: string; actions?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const [more, setMore] = useState(false);
  const say = (text: string) => threadId && void mutate("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
  const other: ImageMaker = card.maker === "openai" ? "claude" : "openai";
  const long = card.prompt.length > 180;
  return (
    <Card pad={space.md} style={st.card}>
      <View style={st.head} testID="image-card-head">
        <MakerMark maker={card.maker} />
        <T v="small" style={{ flex: 1 }} numberOfLines={2}>{imageByline(card)}</T>
      </View>
      {card.stored === false ? (
        <View style={st.missing}>
          <Icon name="hard-drive" size={20} tone={color.textMuted} />
          <T v="small" muted style={{ textAlign: "center" }}>The picture could not be sent to the hub. It is on the connector machine{card.savedPath ? ` at ${card.savedPath}` : ""}.</T>
        </View>
      ) : (
        <Pressable onPress={() => setZoom(true)} accessibilityRole="imagebutton" accessibilityLabel={`${card.name}. Tap to enlarge.`} style={st.frame}>
          {/* A tall picture (a 9:16 reel frame) is held to the height of a phone screen's worth; tapping shows it whole. */}
          <ArtifactImage card={card} style={imageAspect(card) < 0.8 ? { height: 420, aspectRatio: imageAspect(card), alignSelf: "center" } : { width: "100%", aspectRatio: imageAspect(card) }} contain />
        </Pressable>
      )}
      <T v="heading" style={{ fontSize: 15 }} numberOfLines={2}>{card.name}</T>
      <Pressable onPress={long ? () => setMore(!more) : undefined} accessibilityLabel={card.maker === "openai" ? "The brief sent to OpenAI" : "What Claude drew"}>
        <T v="small" numberOfLines={more ? undefined : 3} selectable>{card.maker === "openai" ? `“${card.prompt}”` : card.prompt}</T>
        {long ? <T v="small" tone={color.text} style={{ fontSize: 12 }}>{more ? "Show less" : "Show the whole brief"}</T> : null}
      </Pressable>
      <View style={{ gap: 2 }}>
        <T v="small" muted style={{ fontSize: 12 }}>{imageMeta(card)}</T>
        {card.references.length ? <T v="small" muted style={{ fontSize: 12 }} numberOfLines={2}>{card.base || /overlay/i.test(card.via) ? "On top of" : "Built on"}: {card.references.join(", ")}</T> : null}
        {card.savedPath ? <T v="small" muted style={{ fontSize: 12 }} numberOfLines={2} selectable>Saved to {card.savedPath}</T> : null}
        {card.routedWhy ? <T v="small" muted style={{ fontSize: 12 }} numberOfLines={2}>Why {MAKER_LABEL[card.maker]}: {card.routedWhy}</T> : null}
      </View>
      {actions && threadId ? (
        <View style={st.actions}>
          <Btn small kind="secondary" icon="refresh-cw" label="Again" onPress={() => say(IMAGE_ACTIONS.regenerate(card))} testID="image-again" />
          <Btn small kind="ghost" icon={other === "openai" ? "aperture" : "pen-tool"} label={`Try ${MAKER_LABEL[other]}`} onPress={() => say(IMAGE_ACTIONS.switchMaker(card))} testID="image-switch" />
          <Btn small kind="ghost" icon="bookmark" label="To brand" onPress={() => say(IMAGE_ACTIONS.toBrand(card))} testID="image-brand" />
        </View>
      ) : null}
      <Modal visible={zoom} transparent animationType="fade" onRequestClose={() => setZoom(false)} statusBarTranslucent>
        <Pressable style={st.zoom} onPress={() => setZoom(false)} accessibilityLabel="Close the picture">
          <ArtifactImage card={card} style={{ width: "100%", height: "88%" }} contain />
          <View style={st.zoomFoot}><MakerMark maker={card.maker} /><T v="small" numberOfLines={1} style={{ flexShrink: 1 }}>{card.name}</T></View>
        </Pressable>
      </Modal>
    </Card>
  );
}

/** An image that was not made: the provider's name, what happened, and what to do about it. */
export function ImageIssueCardView({ card }: { card: ImageIssueCard }) {
  return (
    <Card pad={space.md} style={st.card} tone={color.p1}>
      <View style={st.head} testID="image-issue-head">
        <MakerMark maker={card.maker} />
        <T v="small" tone={color.p1} style={{ flex: 1, fontFamily: "SpaceGrotesk_600SemiBold" }}>{card.title}</T>
      </View>
      <T v="small" selectable>{card.message}</T>
      {card.hint ? <T v="small" muted>{card.hint}</T> : null}
      <T v="small" muted style={{ fontSize: 12 }}>No image was made, and nothing was sent to another provider instead.</T>
    </Card>
  );
}

/** One provider's line in the sheet and on the agent's page. */
function ProviderLine({ maker, text, ok }: { maker: ImageMaker; text: string; ok: boolean }) {
  return (
    <View style={st.provider}>
      <MakerMark maker={maker} small />
      <T v="small" tone={ok ? color.textDim : color.p1} style={{ flex: 1 }} selectable>{text}</T>
    </View>
  );
}

/** What this agent's connector says about making images, as shown on the agent's page. */
export function AgentImagesFacts({ agent }: { agent: Agent }) {
  const im = agent.images;
  if (!im) return null;
  const o = openaiLine(im);
  return (
    <View style={{ gap: space.sm }} testID="agent-images">
      <ProviderLine maker="openai" ok={o.ok} text={o.ok ? `${o.text} · Codex ${im.openai.cliVersion ?? "?"}` : o.text} />
      <ProviderLine maker="claude" ok text={im.claude.canRender ? "Draws text, overlays and vector graphics as SVG, and can put them on top of a picture." : "Draws text and vector graphics as SVG. This machine cannot put them on a picture or make PNG previews."} />
      <T v="small" muted style={{ fontSize: 12 }}>
        Images are saved in a session's working directory under {im.saveDir}/. Logos and photos to build on go in {im.brandDir}/. OpenAI: at most {im.openai.capPerRun} images per reply and{" "}
        {im.openai.capPerHour} per hour ({im.openai.imagesLastHour} in the last hour), never retried on its own.
      </T>
    </View>
  );
}

function RouteRow({ value, selected, title, body, onPress }: { value: string; selected: boolean; title: string; body: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${title}. ${body}`} testID={`images-route-${value}`}
      style={({ pressed, hovered }: any) => [st.option, selected && st.optionOn, hovered && !selected && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }]}>
      <View style={{ flex: 1, gap: 1 }}>
        <T v="heading" style={{ fontSize: 15 }}>{title}</T>
        <T v="small">{body}</T>
      </View>
      <View style={[st.radio, selected && { borderColor: color.accent }]}>{selected ? <View style={st.radioDot} /> : null}</View>
    </Pressable>
  );
}

/** The route choices. `own` is this level's own choice (null: follow the level above, worded by `inherit`). Applies as it is tapped. */
export function ImageRouteFields({ own, inherit, onChange }: { own: ImageRoute | null; inherit: { title: string; body: string }; onChange: (r: ImageRoute | null) => void }) {
  return (
    <View style={{ gap: 6 }} accessibilityRole="radiogroup">
      <RouteRow value="inherit" selected={own === null} title={inherit.title} body={inherit.body} onPress={() => onChange(null)} />
      {IMAGE_ROUTES.map((r) => <RouteRow key={r} value={r} selected={own === r} title={ROUTE_TITLE[r]} body={ROUTE_BLURB[r]} onPress={() => onChange(r)} />)}
    </View>
  );
}

/**
 * The chip above the message box and the sheet behind it: who makes images in this session. Shown only
 * when the agent's connector offers image tools. A change applies to the next message.
 */
export function ImagesSwitch({ thread, agent, project }: { thread: Thread; agent: Agent; project?: Project | null }) {
  const [open, setOpen] = useState(false);
  const check = useSetting<boolean>(IMAGE_CHECK_SETTING, false);
  const chip = imagesChip(agent, thread, project);
  if (!chip || !agent.images) return null;
  const above = resolveImageRoute(null, project);
  const o = openaiLine(agent.images);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${chip.text}${chip.warn ? ". OpenAI is not connected" : ""}. Tap to change.`} testID="images-switch" hitSlop={8}
        style={({ pressed, hovered }: any) => [st.pill, hovered && { backgroundColor: color.surface3 }, pressed && { opacity: 0.75 }]}>
        <Icon name="image" size={13} tone={chip.route === "off" ? color.textMuted : color.text} />
        <T v="small" tone={chip.route === "off" ? color.textMuted : color.text} numberOfLines={1} style={st.pillText}>{chip.text}</T>
        {chip.warn ? <Icon name="alert-triangle" size={12} tone={color.p1} /> : <Icon name="chevron-up" size={13} tone={color.textMuted} />}
      </Pressable>
      <Sheet visible={open} title="Images in this session" subtitle={`${agent.name} leads · applies to your next message`} onClose={() => setOpen(false)} testID="images-sheet">
        <Field label="Who can make them">
          <View style={{ gap: space.sm }}>
            <ProviderLine maker="openai" ok={o.ok} text={o.text} />
            <ProviderLine maker="claude" ok text="Draws text treatments, overlays and vector graphics itself, as SVG." />
          </View>
        </Field>
        <Field label="Who makes them here">
          <ImageRouteFields own={thread.imageRoute ?? null}
            inherit={{ title: `${project ? "Project default" : "Default"} (${ROUTE_LABEL[above.route]})`, body: project ? `Follow whatever ${project.name} is set to.` : ROUTE_BLURB[above.route] }}
            onChange={(route) => void mutate("images.set", { scope: "thread", id: thread.id, route })} />
        </Field>
        <View style={st.toggleRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="heading" style={{ fontSize: 15 }}>Claude checks each image</T>
            <T v="small">After OpenAI makes an image, Claude looks at it and tells you if the text or the logo came out wrong. Uses a little of your Claude plan per image. For every session.</T>
          </View>
          <Toggle value={check === true} label="Claude checks each image" onChange={(v) => void mutate("settings.update", { key: IMAGE_CHECK_SETTING, value: v })} />
        </View>
        <View style={st.note}>
          <Icon name="info" size={13} tone={color.textMuted} />
          <T v="small" muted style={{ flex: 1 }}>
            Each image shows who made it. Files are saved under {agent.images.saveDir}/ in this session's working directory. OpenAI is asked for at most {agent.images.openai.capPerRun} images
            per reply and {agent.images.openai.capPerHour} per hour, and never again on its own: use the buttons on an image to try again or to switch maker.
          </T>
        </View>
        <Btn label="Done" onPress={() => setOpen(false)} testID="images-done" />
      </Sheet>
    </>
  );
}

/** Everything made in a project's sessions, newest first, each with its maker. Tapping one opens its session. */
export function ProjectAssets({ projectId, limit = 12 }: { projectId: string; limit?: number }) {
  const messages = useMap("messages");
  const threads = useMap("threads");
  const all = useMemo(() => projectImages(Object.values(messages), threads, projectId), [messages, threads, projectId]);
  const [showAll, setShowAll] = useState(false);
  if (all.length === 0) {
    return <T v="small" muted>Nothing yet. Ask for an image in one of this project's sessions and it shows up here, marked with who made it.</T>;
  }
  const shown = showAll ? all : all.slice(0, limit);
  return (
    <View style={{ gap: space.sm }}>
      <View style={st.grid} testID="project-assets">
        {shown.map(({ message, card, thread }) => (
          <Pressable key={message.id} onPress={() => router.navigate(`/chats/${thread.id}` as any)} accessibilityRole="button"
            accessibilityLabel={`${card.name}, made by ${MAKER_LABEL[card.maker]}, in ${thread.title}`}
            style={({ pressed, hovered }: any) => [st.tile, hovered && { borderColor: color.borderStrong }, pressed && { opacity: 0.8 }]}>
            {card.stored === false ? <View style={[st.missing, { aspectRatio: 1 }]}><Icon name="hard-drive" size={18} tone={color.textMuted} /></View>
              : <ArtifactImage card={card} style={{ width: "100%", aspectRatio: 1 }} />}
            <View style={st.tileFoot}>
              <MakerMark maker={card.maker} small />
              <T v="small" numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>{card.name}</T>
            </View>
          </Pressable>
        ))}
      </View>
      {all.length > limit ? <Btn small kind="ghost" icon={showAll ? "chevron-up" : "grid"} label={showAll ? "Show fewer" : `All ${all.length} images`} onPress={() => setShowAll(!showAll)} /> : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { gap: space.sm, maxWidth: 560, width: "100%" },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  mark: { flexDirection: "row", alignItems: "center", gap: 5, height: 22, paddingHorizontal: 8, borderRadius: 6, backgroundColor: color.accent, alignSelf: "flex-start" },
  markSmall: { height: 18, paddingHorizontal: 6, gap: 4, borderRadius: 5 },
  markText: { fontFamily: "SpaceGrotesk_700Bold", fontSize: 11, lineHeight: 14, letterSpacing: 0.8, color: color.accentInk },
  frame: { borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: color.border, backgroundColor: color.surface2 },
  loading: { backgroundColor: color.surface2 },
  missing: { alignItems: "center", justifyContent: "center", gap: 6, padding: space.lg, minHeight: 120, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  zoom: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center", padding: space.md, gap: space.md },
  zoomFoot: { flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: "100%" },
  provider: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  pill: {
    height: 30, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2,
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", flexShrink: 1, maxWidth: 220,
  },
  pillText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 13, lineHeight: 16, flexShrink: 1 },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg },
  optionOn: { borderColor: color.accent, backgroundColor: color.accentDim },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.accent },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: { flexBasis: "31%", flexGrow: 1, maxWidth: 220, minWidth: 96, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, overflow: "hidden" },
  tileFoot: { flexDirection: "row", alignItems: "center", gap: 6, padding: 6 },
});
