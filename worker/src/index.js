// 주간식단 링크 읽기 서버 (Cloudflare Worker, 무료 요금제)
// POST /read  { url }  with  Authorization: Bearer <Firebase ID token>
// → { kind, title, text, read }
// POST /book  { url }  (a public Notion page holding a recipe database)
// → { title, books: [{ name, categoryName, categories, recipes: [{ title, url, category, time, level, link }] }] }
//
// Browsers can't read Notion, YouTube or Instagram pages from another site, so this small server
// fetches the page and returns its recipe text. The app then finds the 재료 list itself.
// No AI and no paid service; only people signed in to the app (same Firebase project) can use it.

const FIREBASE_PROJECT = "shopping-list-ae06d";
const ALLOWED_ORIGINS = ["https://trykyn.github.io", "http://localhost:8765"];
const MAX_TEXT = 60000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/read" && path !== "/book")) return json({ error: "not_found" }, 404);

    try {
      await verifyFirebaseToken((request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    } catch {
      return json({ error: "unauthorized" }, 401);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
    const url = String(body.url || "").trim().slice(0, 2000);
    if (!url) return json({ error: "bad_request" }, 400);

    if (path === "/book") {
      try { return json(await readNotionBook(url)); }
      catch (e) { console.warn("book failed", url, String(e)); return json({ error: "read_failed" }, 502); }
    }

    let source;
    try { source = await readLink(url); }
    catch (e) { console.warn("read failed", url, String(e)); source = { kind: linkKind(url), title: "", text: "" }; }
    const text = (source.text || "").slice(0, MAX_TEXT);
    return json({ kind: source.kind, title: source.title || "", text, read: Boolean(text) });
  },
};

/* ---------- Firebase sign-in check ---------- */

let keyCache = { keys: null, until: 0 };
async function googleKeys() {
  if (keyCache.keys && Date.now() < keyCache.until) return keyCache.keys;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const { keys } = await r.json();
  const maxAge = Number(((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/) || [])[1] || 3600);
  keyCache = { keys, until: Date.now() + maxAge * 1000 };
  return keys;
}
const importedKeys = new Map();
const b64url = (s) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
async function verifyFirebaseToken(token) {
  const [h, p, sig] = String(token).split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64url(h)));
  const payload = JSON.parse(dec.decode(b64url(p)));
  if (header.alg !== "RS256") throw new Error("alg");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("kid");
  // Imported once per key id (reading a whole recipe book sends many requests in a row).
  let key = importedKeys.get(jwk.kid);
  if (!key) {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    importedKeys.set(jwk.kid, key);
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("signature");
  const now = Date.now() / 1000;
  if (payload.aud !== FIREBASE_PROJECT || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT}`) throw new Error("audience");
  if (!payload.sub || payload.exp < now - 60 || payload.iat > now + 300) throw new Error("expired");
  return payload;
}

/* ---------- reading links ---------- */

function linkKind(raw) {
  try {
    const host = new URL(raw).hostname.replace(/^(www|m)\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    // notion.so (old links), app.notion.com / notion.com (new share links), *.notion.site (published sites)
    if (host.endsWith("notion.site") || host.endsWith("notion.so") || host === "notion.com" || host.endsWith(".notion.com")) return "notion";
  } catch {}
  return "web";
}

async function get(url, init = {}) {
  const r = await fetch(url, {
    redirect: "follow",
    ...init,
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`http ${r.status} ${url}`);
  return r;
}

// A page's text, at most 3 MB of it (a recipe never needs more; a huge page would use up the worker's memory).
async function pageText(r, max = 3_000_000) {
  if (!r.body) return "";
  const reader = r.body.getReader(), decoder = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (size >= max) { await reader.cancel(); break; }
  }
  return out + decoder.decode();
}

/* ---------- Notion ---------- */
// Public Notion pages are read through the same endpoints the Notion website uses.
const plain = (prop) => (Array.isArray(prop) ? prop.map((seg) => (Array.isArray(seg) ? seg[0] : "")).join("") : "");
const unwrap = (rec) => (rec && rec.value && rec.value.value ? rec.value.value : rec && rec.value);
function notionPage(u) {
  const hex = (u.pathname.replace(/-/g, "").match(/[0-9a-f]{32}(?=$|\/|\?)/i) || [])[0] || (u.pathname.match(/[0-9a-f]{32}/i) || [])[0];
  if (!hex) return null;
  return {
    pageId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase(),
    // published sites (*.notion.site) answer on their own address, everything else on notion.so
    call: async (name, body) => (await get(`${u.hostname.endsWith("notion.site") ? u.origin : "https://www.notion.so"}/api/v3/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json(),
  };
}

async function readLink(raw) {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
  const kind = linkKind(raw);
  if (kind === "youtube") return readYouTube(u);
  if (kind === "instagram") return readInstagram(u);
  if (kind === "notion") return readNotion(u);
  return readWebPage(u);
}

// YouTube: title and description (where recipe channels usually list the 재료).
async function readYouTube(u) {
  let id = null;
  if (u.hostname.endsWith("youtu.be")) id = u.pathname.slice(1).split("/")[0];
  else id = u.searchParams.get("v") || (u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/) || [])[2];
  if (!id) return readWebPage(u);
  const watch = `https://www.youtube.com/watch?v=${id}`;
  let title = "", text = "";
  try {
    // The consent cookie skips the "Before you continue to YouTube" page shown to servers in Europe.
    const html = await pageText(await get(`${watch}&hl=ko`, { headers: { Cookie: "SOCS=CAI; CONSENT=YES+cb" } }));
    const player = jsonAfter(html, "ytInitialPlayerResponse = ");
    title = player?.videoDetails?.title || "";
    text = player?.videoDetails?.shortDescription || "";
  } catch (e) { console.warn("youtube page", String(e)); }
  if (!text) {
    // Still no description: ask YouTube's player data endpoint (what the YouTube website itself calls).
    try {
      const r = await get("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: id, context: { client: { clientName: "WEB", clientVersion: "2.20241101.00.00", hl: "ko" } } }),
      });
      const player = await r.json();
      title = title || player?.videoDetails?.title || "";
      text = player?.videoDetails?.shortDescription || "";
    } catch (e) { console.warn("youtube player", String(e)); }
  }
  if (!title) {
    try { title = (await (await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`)).json()).title || ""; } catch {}
  }
  return { kind: "youtube", title, text };
}

// Instagram: the public embed page usually carries the caption without a login.
async function readInstagram(u) {
  const m = u.pathname.match(/\/(p|reel|reels|tv)\/([\w-]+)/);
  if (!m) return readWebPage(u);
  let text = "";
  try {
    const html = await pageText(await get(`https://www.instagram.com/p/${m[2]}/embed/captioned/`));
    const cap = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments/);
    if (cap) text = htmlToText(cap[1].replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/, ""));
    if (!text) {
      const j = html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
      if (j) text = JSON.parse(`"${j[1]}"`);
    }
  } catch (e) { console.warn("instagram embed", String(e)); }
  if (!text) {
    try { text = metaContent(await pageText(await get(u.href)), "og:description"); } catch {}
  }
  return { kind: "instagram", title: "", text: text.trim() };
}

// Notion: public pages (shared to the web) through Notion's page-loading endpoint.
async function readNotion(u) {
  const notion = notionPage(u);
  if (!notion) return readWebPage(u);
  const { pageId, call } = notion;
  try {
    const blocks = {};
    let cursor = { stack: [] };
    for (let chunk = 0; chunk < 5; chunk++) {
      const data = await call("loadCachedPageChunk", { page: { id: pageId }, limit: 100, cursor, chunkNumber: chunk, verticalColumns: false });
      for (const [id, rec] of Object.entries(data?.recordMap?.block || {})) blocks[id] = unwrap(rec);
      cursor = data?.cursor;
      if (!cursor || !cursor.stack || !cursor.stack.length) break;
    }
    const lines = [];
    const walk = (id, depth) => {
      const b = blocks[id];
      if (!b || depth > 6) return;
      const t = plain(b.properties?.title);
      if (t) lines.push((b.type === "bulleted_list" || b.type === "numbered_list" || b.type === "to_do" ? "- " : "") + t);
      for (const child of b.content || []) walk(child, depth + 1);
    };
    walk(pageId, 0);
    const page = blocks[pageId];
    const title = page ? plain(page.properties?.title) : "";
    if (lines.length) return { kind: "notion", title, text: lines.join("\n") };
  } catch (e) { console.warn("notion", String(e)); }
  const fallback = await readWebPage(u);
  return { ...fallback, kind: "notion" };
}

// Notion recipe book: a public page with one or more databases (or a database page itself).
// Lists every recipe with its category (the database's 분류 select), time, difficulty and link.
async function readNotionBook(raw) {
  const u = new URL(raw);
  if (linkKind(raw) !== "notion") throw new Error("not a notion link");
  const notion = notionPage(u);
  if (!notion) throw new Error("no page id");
  const { pageId, call } = notion;
  const linkIn = (prop) => (Array.isArray(prop) ? prop.flatMap((seg) => (Array.isArray(seg) && Array.isArray(seg[1]) ? seg[1] : []))
    .filter((f) => f[0] === "a" && /^https?:/.test(f[1])).map((f) => f[1])[0] || "" : "");

  const chunk = await call("loadCachedPageChunk", { page: { id: pageId }, limit: 100, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false });
  const rm = chunk.recordMap || {};
  const page = unwrap((rm.block || {})[pageId]);
  if (!page) throw new Error("page not public");
  const blocks = [page, ...(page.content || []).map((id) => unwrap((rm.block || {})[id]))].filter(Boolean);

  // Databases on the page, once each (a second view of the same database is skipped).
  const found = new Map();
  for (const b of blocks) {
    if (b.type !== "collection_view" && b.type !== "collection_view_page") continue;
    const viewId = (b.view_ids || [])[0];
    let cid = b.collection_id || (b.format && b.format.collection_pointer && b.format.collection_pointer.id);
    if (!cid && viewId) {
      const v = unwrap((rm.collection_view || {})[viewId]);
      cid = v && v.format && v.format.collection_pointer && v.format.collection_pointer.id;
    }
    if (cid && viewId && !found.has(cid)) found.set(cid, { viewId, spaceId: b.space_id });
  }

  const books = [];
  for (const [cid, { viewId, spaceId }] of found) {
    const sync = await call("syncRecordValues", { requests: [{ pointer: { table: "collection", id: cid, spaceId }, version: -1 }] });
    const coll = unwrap(((sync.recordMap || {}).collection || {})[cid]);
    if (!coll) continue;
    const schema = coll.schema || {};
    const keyWhere = (test) => Object.keys(schema).find((k) => test(schema[k]));
    const catKey = keyWhere((p) => p.type === "select" && /분류|카테고리|종류|category/i.test(p.name))
      || keyWhere((p) => p.type === "select" || p.type === "multi_select");
    const timeKey = keyWhere((p) => /시간|time|min|분/i.test(p.name) && ["number", "text"].includes(p.type));
    const levelKey = keyWhere((p) => /난이도|difficulty|level/i.test(p.name));
    const linkKey = keyWhere((p) => p.type === "file" || p.type === "url");

    const q = await call("queryCollection", {
      source: { type: "collection", id: cid, spaceId },
      collectionView: { id: viewId, spaceId },
      loader: { type: "reducer", reducers: { collection_group_results: { type: "results", limit: 1000 } }, searchQuery: "", userTimeZone: "Europe/Berlin" },
    });
    const ids = (((q.result || {}).reducerResults || {}).collection_group_results || {}).blockIds || [];
    const qblocks = (q.recordMap || {}).block || {};
    const recipes = [];
    for (const id of ids) {
      const b = unwrap(qblocks[id]);
      const p = (b && b.properties) || {};
      const title = plain(p.title).trim();
      if (!title) continue;
      const val = (k) => (k && p[k] ? plain(p[k]).trim() : "");
      recipes.push({
        title,
        url: `https://www.notion.so/${id.replace(/-/g, "")}`,
        category: val(catKey).split(",")[0],
        time: val(timeKey),
        level: val(levelKey).split(",")[0],
        link: linkKey && p[linkKey] ? linkIn(p[linkKey]) || (/^https?:/.test(val(linkKey)) ? val(linkKey) : "") : "",
      });
    }
    books.push({
      name: plain(coll.name),
      categoryName: catKey ? schema[catKey].name : "",
      categories: catKey ? (schema[catKey].options || []).map((o) => o.value) : [],
      recipes,
    });
  }
  return { title: plain(page.properties && page.properties.title), books };
}

// Any other page: a schema.org Recipe if the site has one, otherwise the page text.
async function readWebPage(u) {
  const html = await pageText(await get(u.href));
  const title = metaContent(html, "og:title") || htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const recipe = findRecipe(JSON.parse(m[1]));
      if (recipe && Array.isArray(recipe.recipeIngredient)) {
        return { kind: "web", title: recipe.name || title, text: `재료:\n${recipe.recipeIngredient.map((x) => `- ${x}`).join("\n")}` };
      }
    } catch {}
  }
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || html;
  return { kind: "web", title, text: htmlToText(body) };
}

function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const type = node["@type"];
  if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]);
}

/* ---------- small text helpers ---------- */

function jsonAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  const end = html.indexOf(";</script>", start);
  const raw = html.slice(start, end > 0 ? end : undefined).replace(/;\s*var\s+\w+\s*=[\s\S]*$/, "");
  try { return JSON.parse(raw); } catch { return null; }
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]) : "";
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
