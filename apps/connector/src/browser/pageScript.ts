/**
 * The code HomeBase runs inside a page, in an isolated world: the page's own scripts cannot see it, change
 * it or call it, and it shares only the DOM with them. It turns the page into a short outline with a
 * reference for each thing that can be clicked or typed into, and it answers what a reference really is.
 * That second answer is what the gate judges (gate.ts): the real element, never the model's description.
 *
 * Kept as plain text so that no build step rewrites it.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  if (globalThis.__hb) return true;
  const ids = new WeakMap();
  const refs = new Map();
  let next = 1;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE", "SVG", "CANVAS", "VIDEO", "AUDIO", "OBJECT", "EMBED", "MAP"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "LI", "UL", "OL", "TABLE", "TR", "TD", "TH", "FORM", "FIELDSET", "BLOCKQUOTE", "PRE", "DL", "DT", "DD", "FIGURE", "FIGCAPTION", "DETAILS", "BR", "HR", "LABEL", "TBODY", "THEAD", "ADDRESS", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "combobox", "textbox", "searchbox", "option", "slider", "spinbutton", "treeitem"]);
  const CONTROLS = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[contenteditable=true]";

  const clean = (s, max) => {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };
  const shown = (el) => {
    if (el.hidden) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    return el.getClientRects().length > 0;
  };
  const refFor = (el) => {
    let r = ids.get(el);
    if (!r) {
      r = "e" + next++;
      ids.set(el, r);
    }
    refs.set(r, el);
    return r;
  };
  const inputType = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const roleOf = (el) => {
    const t = el.tagName.toUpperCase();
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = inputType(el);
      if (ty === "hidden") return null;
      if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "range") return "slider";
      if (ty === "file") return "file";
      return ty === "search" ? "searchbox" : "textbox";
    }
    const r = (el.getAttribute("role") || "").toLowerCase();
    if (ROLES.has(r)) return r;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (el.hasAttribute("onclick")) return "button";
    return null;
  };
  const labelText = (el) => {
    try {
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent).join(" ");
    } catch (e) {}
    return "";
  };
  const nameOf = (el, max) => {
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return clean(al, max);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (t.trim()) return clean(t, max);
    }
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const l = labelText(el);
      if (l.trim()) return clean(l, max);
      if (tag === "INPUT") {
        const ty = inputType(el);
        if (ty === "button" || ty === "submit" || ty === "reset") return clean(el.value || ty, max);
        if (ty === "image") return clean(el.alt || "image button", max);
      }
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.id || "", max);
    }
    const txt = clean(el.innerText || el.textContent, max);
    if (txt) return txt;
    const img = el.querySelector ? el.querySelector("img[alt]") : null;
    if (img && img.alt) return clean(img.alt, max);
    return clean(el.getAttribute("title") || "", max);
  };
  /** Offsets of the frames an element sits in, so its position is in the top window's coordinates. */
  const frameOffset = (el) => {
    let x = 0, y = 0;
    try {
      let win = el.ownerDocument.defaultView;
      while (win && win !== win.top && win.frameElement) {
        const r = win.frameElement.getBoundingClientRect();
        x += r.left;
        y += r.top;
        win = win.parent;
      }
    } catch (e) {}
    return { x, y };
  };

  const snapshot = (opts) => {
    opts = opts || {};
    const max = opts.maxChars || 24000;
    const viewportOnly = opts.scope === "viewport";
    const out = [];
    let size = 0, truncated = false, count = 0, line = "", controls = 0, textChars = 0;
    const vh = innerHeight;
    const push = (s) => {
      if (truncated) return;
      if (size + s.length > max) { truncated = true; return; }
      out.push(s);
      size += s.length + 1;
    };
    const flush = () => {
      const t = clean(line, 700);
      line = "";
      if (t) { textChars += t.length; push(t); }
    };
    const walk = (node) => {
      if (truncated || count > 9000) return;
      if (node.nodeType === 3) { line += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      const el = node;
      count++;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      if (!shown(el)) return;
      if (viewportOnly) {
        const r = el.getBoundingClientRect();
        if ((r.width || r.height) && (r.bottom <= 0 || r.top >= vh)) return;
      }
      if (tag === "IFRAME" || tag === "FRAME") {
        flush();
        let doc = null;
        try { doc = el.contentDocument; } catch (e) {}
        if (doc && doc.body) { push("[frame]"); walk(doc.body); flush(); push("[end of frame]"); }
        else push("[frame from " + clean(el.getAttribute("src") || "another site", 120) + ": not readable]");
        return;
      }
      if (tag === "IMG") {
        const alt = clean(el.getAttribute("alt"), 80);
        if (alt) line += " [image: " + alt + "] ";
        return;
      }
      const role = roleOf(el);
      if (role) {
        flush();
        controls++;
        const nested = !!(el.querySelector && role !== "textbox" && role !== "searchbox" && role !== "combobox" && el.querySelector(CONTROLS));
        let s = "[" + refFor(el) + "] " + role + " \"" + nameOf(el, nested ? 60 : 110) + "\"";
        if (role === "link") s += " -> " + clean(el.href, 170);
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const ty = tag === "INPUT" ? inputType(el) : "textarea";
          if (ty !== "text" && ty !== "textarea" && role !== "button") s += " (" + ty + ")";
          if (role === "checkbox" || role === "radio") s += el.checked ? " [checked]" : " [not checked]";
          else if (role !== "button" && ty !== "password" && el.value) s += " value=\"" + clean(el.value, 60) + "\"";
        }
        if (tag === "SELECT") {
          const o = el.selectedOptions && el.selectedOptions[0];
          s += " selected=\"" + clean(o ? o.textContent : "", 60) + "\" options: " + Array.from(el.options).slice(0, 12).map((x) => clean(x.textContent, 30)).join(" | ");
        }
        const exp = el.getAttribute("aria-expanded");
        if (exp === "true" || exp === "false") s += exp === "true" ? " [expanded]" : " [collapsed]";
        if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " [disabled]";
        push(s);
        if (nested) { for (const c of el.childNodes) walk(c); flush(); }
        return;
      }
      const block = BLOCK.has(tag);
      if (block) flush();
      if (/^H[1-6]$/.test(tag) && !(el.querySelector && el.querySelector(CONTROLS))) {
        const t = clean(el.innerText || el.textContent, 220);
        if (t) { textChars += t.length; push("#".repeat(Number(tag[1])) + " " + t); }
        return;
      }
      if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
      for (const c of el.childNodes) walk(c);
      if (block) flush();
    };
    if (document.body) walk(document.body);
    flush();
    const q = (sel) => Array.from(document.querySelectorAll(sel)).filter(shown).length;
    return {
      url: location.href, title: clean(document.title, 200), text: out.join("\n"), truncated,
      facts: {
        passwordFields: q("input[type=password]"),
        otpFields: q("input[autocomplete=one-time-code]"),
        captcha: q("iframe[src*='recaptcha'],iframe[src*='hcaptcha.com'],iframe[src*='challenges.cloudflare.com'],.g-recaptcha,.h-captcha,#challenge-form,#cf-challenge-running") > 0,
        controls, textChars,
        scrollY: Math.round(scrollY), pageHeight: Math.round(document.documentElement.scrollHeight), viewportHeight: Math.round(vh),
      },
    };
  };

  const info = (el, scroll) => {
    if (!el || !el.isConnected) return null;
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const off = frameOffset(el);
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? inputType(el) : tag === "button" ? (el.getAttribute("type") || "submit").toLowerCase() : "";
    const form = el.form || (el.closest ? el.closest("form") : null);
    const textLike = tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color", "hidden"].includes(type));
    return {
      ref: refFor(el), tag, type, role: roleOf(el) || "", name: nameOf(el, 110),
      href: tag === "a" ? String(el.href || "") : "", download: el.hasAttribute("download"), target: el.getAttribute("target") || "",
      autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(), inputName: el.getAttribute("name") || "", id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "", ariaLabel: el.getAttribute("aria-label") || "", label: clean(labelText(el), 110),
      editable: textLike || !!el.isContentEditable,
      inForm: !!form, formAction: form ? String(form.action || "") : "", formMethod: form ? String(form.getAttribute("method") || "get").toLowerCase() : "",
      submit: !!form && ((tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"))),
      expander: tag === "summary" || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") || (el.getAttribute("role") || "") === "tab",
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      x: off.x + r.left + r.width / 2, y: off.y + r.top + r.height / 2, w: r.width, h: r.height,
    };
  };
  const describe = (ref, scroll) => info(refs.get(ref), !!scroll);
  const focused = () => {
    let a = document.activeElement;
    for (let i = 0; a && i < 8; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      let inner = null;
      try { inner = (a.tagName === "IFRAME" || a.tagName === "FRAME") && a.contentDocument ? a.contentDocument.activeElement : null; } catch (e) {}
      if (inner) { a = inner; continue; }
      break;
    }
    if (!a || a.tagName === "BODY" || a.tagName === "HTML") return null;
    return info(a, false);
  };
  const focus = (ref, clear) => {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return false;
    el.focus();
    if (clear) {
      if (typeof el.select === "function") el.select();
      else if (el.isContentEditable) { const s = getSelection(); s.selectAllChildren(el); }
    }
    return true;
  };
  const select = (ref, values) => {
    const el = refs.get(ref);
    if (!el || !el.isConnected || el.tagName !== "SELECT") return null;
    const want = values.map((v) => String(v).trim().toLowerCase());
    const picked = [];
    for (const o of Array.from(el.options)) {
      const hit = want.includes(String(o.value).toLowerCase()) || want.includes(clean(o.textContent, 200).toLowerCase());
      if (el.multiple) o.selected = hit;
      else if (hit && !picked.length) el.value = o.value;
      if (hit && (el.multiple || !picked.length)) picked.push(clean(o.textContent, 60));
    }
    if (picked.length) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return picked;
  };
  const find = (text) => {
    const needle = String(text || "").toLowerCase();
    if (!needle) return { count: 0, hits: [] };
    const hits = [];
    let count = 0, first = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && count < 500; n = walker.nextNode()) {
      const v = n.nodeValue || "";
      const i = v.toLowerCase().indexOf(needle);
      if (i < 0) continue;
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName.toUpperCase()) || !shown(p)) continue;
      count++;
      if (!first) first = p;
      if (hits.length < 6) hits.push(clean(v.slice(Math.max(0, i - 90), i + needle.length + 90), 220));
    }
    if (first) first.scrollIntoView({ block: "center", behavior: "instant" });
    return { count, hits };
  };

  globalThis.__hb = { snapshot, describe, focused, focus, select, find };
  return true;
})()`;
