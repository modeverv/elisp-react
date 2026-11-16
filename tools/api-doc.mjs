// A Markdown document of the repository (doc/api.md, a README) as one HTML
// page for GitHub Pages: a contents sidebar with a filter, headings with the
// anchors GitHub gives them (so links written for GitHub work here too),
// Emacs Lisp coloured, relative links sent to the repository.  A link to an
// anchor that the page does not have stops the build.
//
//   node tools/api-doc.mjs --in doc/api.md --out _site/api/index.html \
//     --title "elisp-react API" --repo modeverv/elisp-react \
//     [--ref main] [--nav "Label=URL"]... [--link "PATH=URL"]... [--version v0.1.0]
//     [--lang ja] [--alt "English=../"]
//
// A heading right after a line <a id="ID"></a> has the anchor ID (and its
// own one too): a translation keeps the anchors of the original, so its
// links work and --alt, the other language, opens at the same place.
//
// --link sends a link to PATH (relative to the repository, or a full URL,
// with or without an anchor) to URL instead, e.g. the API page of a sibling
// project.  Markdown: marked (tools/vendor/marked, MIT).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { Marked } from "./vendor/marked/marked.esm.js";

const args = { nav: [], link: [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  const value = process.argv[i + 1];
  if (value === undefined) throw new Error(`${process.argv[i]} needs a value`);
  if (Array.isArray(args[key])) args[key].push(value); else args[key] = value;
}
for (const key of ["in", "out", "title", "repo"]) {
  if (!args[key]) throw new Error(`--${key} is required`);
}
const ref = args.ref || "main";
const ja = args.lang === "ja";
const words = ja
  ? { filter: "絞り込み（名前、言葉）", filterLabel: "目次を絞り込む", contents: "目次", none: "該当なし", copy: "コピー", copied: "コピーしました", select: "選択してください", self: "この節へのリンク",
      footer: (link) => `${link} から作成しました。Markdown が正本です。` }
  : { filter: "Filter (a name, a word)", filterLabel: "Filter the contents", contents: "Contents", none: "Nothing matches.", copy: "Copy", copied: "Copied", select: "Select it", self: "Link to this section",
      footer: (link) => `Generated from ${link}. The Markdown is the source: agents can read it as it is.` };
// <a id="ID"></a> on the line before a heading: the heading's anchor.
const source = readFileSync(args.in, "utf8").replace(/^<a id="([^"]+)"><\/a>[ \t]*\n(#{1,6} [^\n]*)$/gm, "$2 <!--id:$1-->");
const sourceDir = posix.dirname(args.in.replace(/\\/g, "/").replace(/^\.\//, ""));
const links = args.link.map((pair) => {
  const at = pair.indexOf("=");
  return [pair.slice(0, at), pair.slice(at + 1)];
});

const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const unescape = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

// GitHub's anchors (github-slugger): the heading's text, lower case, without
// what is neither a letter, a digit, "_", "-" nor a space; spaces become "-";
// a repeated one gets -1, -2 ...
const used = new Map();
function slug(text) {
  const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
  let id = base;
  for (let n = used.get(base) || 0; used.has(id); n++) id = `${base}-${n + 1}`, used.set(base, n + 1);
  used.set(id, used.get(id) || 0);
  return id;
}

// Emacs Lisp, coloured: comments, strings, keywords, quoted symbols, and the
// head of a definition.
const defining = /^(def\w*|cl-def\w*|react-define-component|nextel-page|nextel-layout|nextel-handle|nextel-defschema|lambda|let\*?|if|when|unless|cond|pcase|progn|while|dolist|dotimes|condition-case|unwind-protect|with-temp-buffer|react-async|jsx)$/;
function lisp(code) {
  let out = "", i = 0, afterParen = false;
  const symbol = /^[^\s()"';`,\[\]#]+/;
  while (i < code.length) {
    const rest = code.slice(i);
    let m;
    if (rest[0] === ";") {
      const end = rest.indexOf("\n");
      const text = end < 0 ? rest : rest.slice(0, end);
      out += `<span class="c">${escape(text)}</span>`; i += text.length; afterParen = false;
    } else if (rest[0] === '"') {
      let j = 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      const text = rest.slice(0, j + 1);
      out += `<span class="s">${escape(text)}</span>`; i += text.length; afterParen = false;
    } else if (rest[0] === "?" && rest.length > 1 && !/\s/.test(rest[1])) {
      const text = rest[1] === "\\" ? rest.slice(0, 3) : rest.slice(0, 2);
      out += `<span class="s">${escape(text)}</span>`; i += text.length; afterParen = false;
    } else if ((m = /^(#'|')[^\s()"';`,\[\]]+/.exec(rest))) {
      out += `<span class="q">${escape(m[0])}</span>`; i += m[0].length; afterParen = false;
    } else if ((m = symbol.exec(rest))) {
      const word = m[0];
      const cls = word.startsWith(":") ? "k" : afterParen && defining.test(word) ? "d" : /^-?\d+(\.\d+)?$/.test(word) || word === "nil" || word === "t" ? "n" : "";
      out += cls ? `<span class="${cls}">${escape(word)}</span>` : escape(word);
      i += word.length; afterParen = false;
    } else {
      afterParen = rest[0] === "(";
      out += escape(rest[0]); i += 1;
    }
  }
  return out;
}

function target(href) {
  if (/^(#|mailto:)/.test(href)) return href;
  for (const [from, to] of links) {
    const [path, anchor] = href.split("#");
    const resolved = /^[a-z]+:/i.test(path) ? path : posix.normalize(posix.join(sourceDir, path));
    if (resolved === from) return anchor ? `${to}#${anchor}` : to;
  }
  if (/^[a-z]+:/i.test(href)) return href;
  const [path, anchor] = href.split("#");
  const resolved = posix.normalize(posix.join(sourceDir, path));
  return `https://github.com/${args.repo}/blob/${ref}/${resolved}${anchor ? `#${anchor}` : ""}`;
}

const headings = [];
const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      let html = this.parser.parseInline(tokens);
      const explicit = /\s*<!--id:([^>]*)-->\s*$/.exec(html);
      if (explicit) html = html.slice(0, explicit.index);
      const own = slug(unescape(html.replace(/<[^>]*>/g, "")));
      const id = explicit ? explicit[1] : own;
      // GitHub's anchor of the heading as written, as well.
      const alias = id !== own ? `<a class="alias" id="${own}" aria-hidden="true"></a>` : "";
      if (depth >= 2 && depth <= 4) headings.push({ depth, id, html });
      const self = depth >= 2 ? `<a class="self" href="#${id}" aria-label="${words.self}">#</a>` : "";
      return `<h${depth} id="${id}">${alias}${html}${self}</h${depth}>\n`;
    },
    code({ text, lang }) {
      const kind = (lang || "").split(/\s/)[0];
      const body = /^(elisp|emacs-lisp|lisp)$/.test(kind) ? lisp(text) : escape(text);
      return `<div class="code"><pre><code${kind ? ` class="language-${escape(kind)}"` : ""}>${body}</code></pre>`
        + `<button class="copy" type="button" aria-label="${words.copy}">${words.copy}</button></div>\n`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const to = target(href);
      const external = /^https?:/.test(to) && !to.startsWith("#");
      return `<a href="${escape(to)}"${title ? ` title="${escape(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${label}</a>`;
    },
    table(token) {
      const head = token.header.map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`).join("");
      const rows = token.rows.map((row) => `<tr>${row.map((cell) => `<td${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("\n");
      return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
    },
  },
});

const body = marked.parse(source);

// Every link to an anchor of this page must find it.
const ids = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const missing = [...new Set([...body.matchAll(/href="#([^"]+)"/g)].map((m) => unescape(m[1])))].filter((id) => !ids.has(id));
if (missing.length) {
  console.error(`api-doc: ${args.in}: links to anchors that are not there:\n  #${missing.join("\n  #")}`);
  process.exit(1);
}

// The contents: the h2 sections with their h3; the filter looks at h4 too.
let toc = "", open = false;
for (const h of headings.filter((h) => !(h.depth === 2 && h.id === "contents"))) {
  const text = h.html.replace(/<a [^>]*>|<\/a>/g, "");
  if (h.depth === 2) {
    if (open) toc += "</ul></li>";
    toc += `<li class="h2"><a href="#${h.id}">${text}</a><ul>`; open = true;
  } else {
    toc += `<li class="h${h.depth}"><a href="#${h.id}">${text}</a></li>`;
  }
}
if (open) toc += "</ul></li>";

const pairLink = (pair, attrs = "") => {
  const at = pair.indexOf("=");
  return `<a href="${escape(pair.slice(at + 1))}"${attrs}>${escape(pair.slice(0, at))}</a>`;
};
const nav = (args.alt ? pairLink(args.alt, ` class="lang" hreflang="${ja ? "en" : "ja"}"`) : "") + args.nav.map((pair) => pairLink(pair)).join("");
const description = escape((source.split("\n").find((line) => line && !line.startsWith("#") && !line.startsWith("<")) || args.title)
  .replace(/[`*_\[\]]|\([^)]*\)/g, "").slice(0, 200));

const page = `<!doctype html>
<html lang="${ja ? "ja" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(args.title)}</title>
<meta name="description" content="${description}">
<style>
:root { color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --soft: #f6f8fa; --link: #0969da;
  --accent: #8250df; --code-bg: #f6f8fa; --c: #6e7781; --s: #0a3069; --k: #8250df; --q: #116329; --d: #cf222e; --n: #0550ae; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --soft: #151b23; --link: #4493f8;
  --accent: #ab7df8; --code-bg: #151b23; --c: #9198a1; --s: #a5d6ff; --k: #d2a8ff; --q: #7ee787; --d: #ff7b72; --n: #79c0ff; } }
* { box-sizing: border-box; }
html { scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Hiragino Sans", "Noto Sans JP", Meiryo, Helvetica, Arial, sans-serif; }
:lang(ja) main { line-height: 1.8; }
header.top nav a.lang { font-weight: 600; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
header.top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  padding: .6rem 1.25rem; background: var(--bg); border-bottom: 1px solid var(--line); }
header.top .name { font-weight: 700; font-size: 1.05rem; color: var(--fg); }
header.top .version { color: var(--muted); font-size: .85rem; }
header.top nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-left: auto; font-size: .9rem; }
.layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); max-width: 84rem; margin: 0 auto; }
aside { position: sticky; top: 3.2rem; height: calc(100vh - 3.2rem); overflow-y: auto; padding: 1rem .75rem 2rem 1.25rem; border-right: 1px solid var(--line); font-size: .875rem; }
aside input { width: 100%; padding: .4rem .55rem; margin-bottom: .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--fg); font: inherit; }
aside ul { list-style: none; margin: 0; padding: 0; }
aside li.h2 > a { display: block; font-weight: 600; margin-top: .6rem; color: var(--fg); }
aside li.h3 a, aside li.h4 a { display: block; padding: .1rem 0 .1rem .75rem; color: var(--muted); overflow-wrap: anywhere; }
aside li.h4 { display: none; } aside li.h4 a { padding-left: 1.5rem; }
aside.filtering li.h4 { display: block; }
aside a.current { color: var(--accent) !important; }
aside .none { color: var(--muted); display: none; }
main { min-width: 0; padding: 1.5rem 2.5rem 4rem; }
main > h1:first-child { margin-top: 0; }
h1, h2, h3, h4 { line-height: 1.25; position: relative; }
h1 { font-size: 2rem; } h2 { font-size: 1.5rem; margin-top: 2.5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.2rem; margin-top: 2rem; } h4 { font-size: 1rem; margin-top: 1.6rem; }
h2 code, h3 code, h4 code { font-size: .9em; }
a.self { margin-left: .4rem; color: var(--muted); opacity: 0; font-weight: 400; }
h2:hover a.self, h3:hover a.self, h4:hover a.self, a.self:focus { opacity: 1; }
code { font: .875em/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; background: var(--code-bg); padding: .15em .35em; border-radius: 4px; overflow-wrap: anywhere; }
.code { position: relative; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: .85rem 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: .85rem; overflow-wrap: normal; }
button.copy { position: absolute; top: .45rem; right: .45rem; font: .75rem/1 inherit; padding: .3rem .5rem; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); color: var(--muted); cursor: pointer; opacity: 0; }
.code:hover button.copy, button.copy:focus { opacity: 1; }
.c { color: var(--c); font-style: italic; } .s { color: var(--s); } .k { color: var(--k); } .q { color: var(--q); } .d { color: var(--d); font-weight: 600; } .n { color: var(--n); }
.table { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; font-size: .9rem; } th, td { border: 1px solid var(--line); padding: .4rem .7rem; vertical-align: top; }
th { background: var(--soft); text-align: left; }
blockquote { margin: 1rem 0; padding: 0 1rem; color: var(--muted); border-left: .25rem solid var(--line); }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
@media (max-width: 52rem) {
  .layout { display: block; }
  aside { position: static; height: auto; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); padding: .75rem 1rem; }
  aside summary { cursor: pointer; font-weight: 600; }
  main { padding: 1rem 1rem 3rem; }
  header.top { position: static; padding: .6rem 1rem; }
  html { scroll-padding-top: .5rem; }
  header.top nav { margin-left: 0; }
}
@media (min-width: 52.01rem) { aside summary { display: none; } }
</style>
</head>
<body>
<header class="top">
  <a class="name" href="#">${escape(args.title)}</a>${args.version ? `<span class="version">${escape(args.version)}</span>` : ""}
  <nav>${nav}<a href="https://github.com/${escape(args.repo)}">GitHub</a></nav>
</header>
<div class="layout">
<aside id="toc">
  <details open><summary>${words.contents}</summary>
  <input type="search" placeholder="${words.filter}" aria-label="${words.filterLabel}">
  <ul>${toc}</ul><p class="none">${words.none}</p>
  </details>
</aside>
<main>
${body}
<footer>${words.footer(`<a href="https://github.com/${escape(args.repo)}/blob/${escape(ref)}/${escape(args.in.replace(/^\.\//, ""))}">${escape(args.in.replace(/^\.\//, ""))}</a>${args.commit ? ` (${escape(args.commit.slice(0, 7))})` : ""}`)}</footer>
</main>
</div>
<script>
// The filter, the section being read, and the copy buttons.
const aside = document.getElementById("toc"), input = aside.querySelector("input"), none = aside.querySelector(".none");
input.addEventListener("input", () => {
  const words = input.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  aside.classList.toggle("filtering", words.length > 0);
  let shown = 0;
  for (const li of aside.querySelectorAll("li")) {
    if (li.classList.contains("h2")) continue;
    const hit = words.every((w) => li.textContent.toLowerCase().includes(w));
    li.style.display = words.length ? (hit ? "block" : "none") : "";
    if (hit) shown++;
  }
  for (const li of aside.querySelectorAll("li.h2")) {
    const own = words.every((w) => li.firstElementChild.textContent.toLowerCase().includes(w));
    const any = [...li.querySelectorAll("li")].some((x) => x.style.display === "block");
    li.style.display = !words.length || own || any ? "" : "none";
    if (own) shown++;
  }
  none.style.display = words.length && !shown ? "block" : "none";
});
const tocLinks = new Map([...aside.querySelectorAll("a")].map((a) => [a.getAttribute("href").slice(1), a]));
const watched = [...document.querySelectorAll("main h2[id], main h3[id], main h4[id]")].filter((h) => tocLinks.has(h.id));
const details = aside.querySelector("details");
if (matchMedia("(max-width: 52rem)").matches) details.open = false;
let current = null, pending = false;
function follow() {
  pending = false;
  let here = null;
  for (const h of watched) {
    if (h.getBoundingClientRect().top > innerHeight * 0.2) break;
    const link = tocLinks.get(h.id);
    if (link.offsetParent !== null) here = link;
  }
  if (here === current) return;
  current?.classList.remove("current"); current = here; here?.classList.add("current");
  if (here && getComputedStyle(aside).position === "sticky") {
    const box = aside.getBoundingClientRect(), at = here.getBoundingClientRect();
    if (at.top < box.top + 40 || at.bottom > box.bottom - 20) aside.scrollTop += at.top - box.top - box.height / 3;
  }
}
addEventListener("scroll", () => { if (!pending) { pending = true; requestAnimationFrame(follow); } }, { passive: true });
addEventListener("hashchange", () => requestAnimationFrame(follow));
input.addEventListener("input", () => requestAnimationFrame(follow));
follow();
for (const button of document.querySelectorAll("button.copy")) {
  button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(button.previousElementSibling.textContent); button.textContent = ${JSON.stringify(words.copied)}; }
    catch { button.textContent = ${JSON.stringify(words.select)}; }
    setTimeout(() => (button.textContent = ${JSON.stringify(words.copy)}), 1500);
  });
}
// The other language, at the same place: the anchors are the same.
for (const link of document.querySelectorAll("header a.lang")) {
  link.addEventListener("click", (event) => {
    if (!location.hash) return;
    event.preventDefault();
    location.href = link.href.split("#")[0] + location.hash;
  });
}
</script>
</body>
</html>
`;

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, page);
console.log(`api-doc: ${args.in} -> ${args.out} (${headings.length} headings, ${ids.size} anchors)`);
