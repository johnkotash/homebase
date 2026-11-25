import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { lintGutter, lintKeymap, linter } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { EditorLanguage } from "@homebase/protocol";

/**
 * The editor (CodeMirror 6): line numbers, undo/redo, find and replace, bracket matching, folding, syntax colours
 * by file type, indentation that follows the file (tabs or N spaces), and JSON errors underlined as you type.
 */

export const indentConf = new Compartment();
export const readOnlyConf = new Compartment();

export function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case "json": return [json(), linter(jsonParseLinter(), { delay: 400 }), lintGutter()];
    case "python": return python();
    case "shell": return StreamLanguage.define(shell);
    case "javascript": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "typescript": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "markdown": return markdown();
    case "yaml": return yaml();
    case "css": return css();
    case "html": return html();
    default: return [];
  }
}

export const LANGUAGE_LABEL: Record<EditorLanguage, string> = {
  json: "JSON", python: "Python", shell: "Shell", javascript: "JavaScript", jsx: "JavaScript JSX", typescript: "TypeScript", tsx: "TypeScript JSX",
  markdown: "Markdown", yaml: "YAML", css: "CSS", html: "HTML", plain: "Plain text",
};

export const indentExtension = (tabs: boolean, size: number): Extension => [indentUnit.of(tabs ? "\t" : " ".repeat(size)), EditorState.tabSize.of(tabs ? 4 : size)];

/** Quiet syntax colours on the app's black: greys for structure, a few soft hues for what matters when reading code. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword], color: "#C9A7F5" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#9FD39B" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#F0B77A" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#6F6F6F", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8DB6EC" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#E8E8E8" },
  { tag: [t.typeName, t.className, t.namespace], color: "#7DD3D8" },
  { tag: [t.propertyName, t.attributeName], color: "#B5C7E8" },
  { tag: [t.tagName, t.angleBracket], color: "#E5868C" },
  { tag: [t.heading], color: "#FAFAFA", fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#8DB6EC", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "#A3A3A3" },
  { tag: [t.invalid], color: "#F0484E" },
  { tag: [t.variableName], color: "#E5E5E5" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#A3A3A3" },
]);

const theme = EditorView.theme({
  "&": { color: "#E5E5E5", backgroundColor: "#000000", height: "100%", fontSize: "13.5px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace", lineHeight: "1.55" },
  ".cm-content": { caretColor: "#FFFFFF" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#FFFFFF", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#3A3A3A !important" },
  ".cm-gutters": { backgroundColor: "#000000", color: "#5A5A5A", border: "none", borderRight: "1px solid #1F1F1F" },
  ".cm-activeLineGutter": { backgroundColor: "#0E0E0E", color: "#C8C8C8" },
  ".cm-activeLine": { backgroundColor: "#0B0B0B" },
  ".cm-selectionMatch": { backgroundColor: "#262626" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "#2E2E2E", outline: "1px solid #4A4A4A" },
  ".cm-searchMatch": { backgroundColor: "rgba(224,163,58,0.25)", outline: "1px solid rgba(224,163,58,0.5)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(224,163,58,0.5)" },
  ".cm-panels": { backgroundColor: "#0E0E0E", color: "#E5E5E5", borderColor: "#262626" },
  ".cm-panels-top": { borderBottom: "1px solid #262626" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "inherit" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "13px" },
  ".cm-textfield": { backgroundColor: "#000", color: "#FAFAFA", border: "1px solid #3A3A3A", borderRadius: "6px", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "#1F1F1F", color: "#FAFAFA", border: "1px solid #3A3A3A", borderRadius: "6px" },
  ".cm-tooltip": { backgroundColor: "#161616", color: "#E5E5E5", border: "1px solid #3A3A3A" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#2E2E2E", color: "#FFF" },
  ".cm-diagnostic-error": { borderLeftColor: "#F0484E" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #F0484E" },
  ".cm-foldPlaceholder": { backgroundColor: "#1F1F1F", border: "none", color: "#A3A3A3" },
}, { dark: true });

export interface StateOptions {
  doc: string;
  lang: EditorLanguage;
  tabs: boolean;
  indentSize: number;
  readOnly: boolean;
  extra?: Extension;
}

export function createState(o: StateOptions): EditorState {
  return EditorState.create({
    doc: o.doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(highlight, { fallback: true }), bracketMatching(), closeBrackets(),
      autocompletion({ activateOnTyping: false }), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
      indentConf.of(indentExtension(o.tabs, o.indentSize)),
      readOnlyConf.of([EditorState.readOnly.of(o.readOnly), EditorView.editable.of(!o.readOnly)]),
      languageExtension(o.lang),
      theme,
      o.extra ?? [],
    ],
  });
}
