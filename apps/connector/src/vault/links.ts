// Wikilink parsing and resolution live in the protocol package so the app resolves links the same way, offline.
export { parseLinks, resolveLink, type Backlink, type NoteLink, type Resolution } from "@homebase/protocol";
