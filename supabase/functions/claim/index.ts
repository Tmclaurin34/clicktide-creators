// Supporter claim API (and the streamer card preview: GET ?preview=1).
//   GET  ?token=<claim token>  -> public details about the reward. If the request carries the
//        supporter's own login, it also returns their saved address so the form is prefilled.
//   POST { token, size, address, age_confirmed, save_address } with the supporter's login
//        -> verifies the supporter is the same Twitch account, stores the address with the
//           claim (never deleted), saves it for next time, and sends the gift: cards (Lob),
//           pen-written cards (Simply Noted) or posters (Printful).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const LOB_API_KEY = Deno.env.get("LOB_API_KEY") ?? "";
const LOB_FROM_ADDRESS_ID = Deno.env.get("LOB_FROM_ADDRESS_ID") ?? "";
// Posters (Printful). Orders stay as drafts you approve in Printful until PRINTFUL_AUTO_CONFIRM=true.
const PRINTFUL_API_KEY = Deno.env.get("PRINTFUL_API_KEY") ?? "";
const PRINTFUL_STORE_ID = Deno.env.get("PRINTFUL_STORE_ID") ?? "";
const PRINTFUL_AUTO_CONFIRM = Deno.env.get("PRINTFUL_AUTO_CONFIRM") === "true";
const PRINTFUL_POSTER_PRODUCT_ID = Deno.env.get("PRINTFUL_POSTER_PRODUCT_ID") ?? "1"; // Enhanced Matte Paper Poster (in)
// Pen-written cards (Simply Noted). Test mode ("Do Not Mail") stays on until SIMPLY_NOTED_TEST=false.
const SN_API_KEY = Deno.env.get("SIMPLY_NOTED_API_KEY") ?? "";
const SN_USER_ID = Deno.env.get("SIMPLY_NOTED_USER_ID") ?? "";
const SN_CARD_ID = Deno.env.get("SIMPLY_NOTED_CARD_ID") ?? "";
const SN_SENDER_ID = Deno.env.get("SIMPLY_NOTED_SENDER_ID") ?? "";
const SN_TEST = Deno.env.get("SIMPLY_NOTED_TEST") !== "false";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZED_ITEMS = new Set(["tee", "hoodie"]);
const SIZES = new Set(["S", "M", "L", "XL", "2XL"]);

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function loadClaim(token: string) {
  return await db
    .from("claims")
    .select("id, status, size, expires_at, created_at, streamer_id, supporter_id, rewards(name, tier, item_type, unlock_rule), streamers(display_name, avatar_url), supporters(display_name, platform, platform_user_id)")
    .eq("claim_token", token)
    .maybeSingle();
}

const STORAGE_PREFIX = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/card-assets/`;
const DEFAULT_MESSAGE = "Thank you for showing up for the stream. It means more than you know.";

type CardDesign = {
  template?: string | null;
  photo_urls?: string[] | null;
  logo_url?: string | null;
  signature_url?: string | null;
  front_url?: string | null;
  message?: string | null;
  accent_color?: string | null;
  background_color?: string | null;
  style_seed?: number | null;
};
type CardInfo = {
  streamer: string;
  avatar?: string | null; // Twitch profile picture, used until the streamer uploads photos
  supporter: string;
  reward: string;
  statLine: string;   // e.g. "You gifted 25 subs in November."
  number: string;     // e.g. "#12 · November 2026"
  cardIndex: number;  // this card's number in the month; picks which photo is used
  tier?: string | null; // common | rare | epic | legendary: rarer gifts get a special border and a bigger format
  styleKey: string;   // fallback seed (streamer id) when no style was saved
  design: CardDesign;
};

// Only our own storage and Twitch's image host ever go into a card.
const safeImg = (u?: string | null) =>
  u && (u.startsWith(STORAGE_PREFIX) || u.startsWith("https://static-cdn.jtvnw.net/")) ? esc(u) : "";
const safeColor = (c: string | null | undefined, fallback: string) => (c && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : fallback);

// ---------- Per-streamer style: every channel's cards look different ----------
const FONT_PAIRS = [
  { head: "Fraunces", headCss: "'Fraunces',Georgia,serif", hand: "Caveat", handCss: "'Caveat',cursive", q: "Fraunces:wght@700&family=Caveat:wght@600;700", headSize: 1, handSize: 1 },
  { head: "Bebas Neue", headCss: "'Bebas Neue',Impact,sans-serif", hand: "Permanent Marker", handCss: "'Permanent Marker',cursive", q: "Bebas+Neue&family=Permanent+Marker", headSize: 1.35, handSize: 0.82 },
  { head: "Archivo Black", headCss: "'Archivo Black',Arial Black,sans-serif", hand: "Kalam", handCss: "'Kalam',cursive", q: "Archivo+Black&family=Kalam:wght@400;700", headSize: 0.95, handSize: 0.85 },
  { head: "Playfair Display", headCss: "'Playfair Display',Georgia,serif", hand: "Dancing Script", handCss: "'Dancing Script',cursive", q: "Playfair+Display:wght@800&family=Dancing+Script:wght@600;700", headSize: 1, handSize: 0.95 },
  { head: "Anton", headCss: "'Anton',Impact,sans-serif", hand: "Shadows Into Light", handCss: "'Shadows Into Light',cursive", q: "Anton&family=Shadows+Into+Light", headSize: 1.2, handSize: 0.95 },
  { head: "Righteous", headCss: "'Righteous',Arial,sans-serif", hand: "Patrick Hand", handCss: "'Patrick Hand',cursive", q: "Righteous&family=Patrick+Hand", headSize: 1, handSize: 0.9 },
  { head: "Abril Fatface", headCss: "'Abril Fatface',Georgia,serif", hand: "Satisfy", handCss: "'Satisfy',cursive", q: "Abril+Fatface&family=Satisfy", headSize: 1, handSize: 0.9 },
  { head: "Russo One", headCss: "'Russo One',Arial,sans-serif", hand: "Nanum Pen Script", handCss: "'Nanum Pen Script',cursive", q: "Russo+One&family=Nanum+Pen+Script", headSize: 0.95, handSize: 1.15 },
];
const PATTERNS = ["none", "dots", "stripes", "grid", "halftone", "rays"];
const FRAMES = ["none", "inset", "print", "double"];

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function styleFrom(seed: number) {
  const n = Math.abs(Math.floor(seed));
  return {
    fonts: FONT_PAIRS[n % FONT_PAIRS.length],
    pattern: PATTERNS[Math.floor(n / FONT_PAIRS.length) % PATTERNS.length],
    frame: FRAMES[Math.floor(n / (FONT_PAIRS.length * PATTERNS.length)) % FRAMES.length],
  };
}
const STYLE_COUNT = FONT_PAIRS.length * PATTERNS.length * FRAMES.length;

function patternCss(kind: string, color: string): string {
  const c = color + "40"; // ~25% opacity
  switch (kind) {
    case "dots": return `background-image:radial-gradient(${c} 1.2px, transparent 1.6px);background-size:0.16in 0.16in;`;
    case "stripes": return `background-image:repeating-linear-gradient(135deg, ${c} 0 0.03in, transparent 0.03in 0.18in);`;
    case "grid": return `background-image:linear-gradient(${c} 1px, transparent 1px),linear-gradient(90deg, ${c} 1px, transparent 1px);background-size:0.25in 0.25in;`;
    case "halftone": return `background-image:radial-gradient(circle at 100% 0%, ${color}55 0, transparent 2.6in),radial-gradient(${c} 1.6px, transparent 2px);background-size:auto,0.12in 0.12in;`;
    case "rays": return `background-image:repeating-conic-gradient(from 0deg at 85% 15%, ${c} 0deg 6deg, transparent 6deg 18deg);`;
    default: return "";
  }
}
function frameHtml(kind: string, accent: string): string {
  switch (kind) {
    case "inset": return `<div style="position:absolute;inset:0.18in;border:0.025in solid ${accent};border-radius:0.08in;pointer-events:none;"></div>`;
    case "print": return `<div style="position:absolute;inset:0;border:0.16in solid #FFFFFF;pointer-events:none;"></div>`;
    case "double": return `<div style="position:absolute;inset:0.14in;border:0.02in solid #FFFFFF;outline:0.02in solid ${accent};outline-offset:0.05in;pointer-events:none;"></div>`;
    default: return "";
  }
}
function tierHtml(tier: string | null | undefined, accent: string): string {
  if (tier === "legendary") {
    return `<div style="position:absolute;inset:0;border:0.11in solid transparent;border-image:linear-gradient(135deg,#F6E27A,#B8862B,#FFF4C2,#A8741A,#F6E27A) 1;pointer-events:none;"></div>
<div style="position:absolute;left:50%;top:0.1in;transform:translateX(-50%);background:linear-gradient(90deg,#B8862B,#F6E27A,#B8862B);color:#2A1E05;font-family:Inter,Arial,sans-serif;font-weight:800;font-size:7pt;letter-spacing:2px;padding:0.03in 0.14in;border-radius:0.1in;">LEGENDARY</div>`;
  }
  if (tier === "epic") {
    return `<div style="position:absolute;inset:0;border:0.08in solid transparent;border-image:linear-gradient(135deg,${accent},#8B5CF6,#EC4899,${accent}) 1;pointer-events:none;"></div>`;
  }
  if (tier === "rare") return `<div style="position:absolute;inset:0;border:0.05in solid ${accent};pointer-events:none;"></div>`;
  return "";
}

// Print sizes (inches, including 0.125in bleed). Rarer gifts get bigger formats.
type Dims = { w: number; h: number };
const POSTCARD_DIMS: Record<string, Dims> = {
  "4x6": { w: 6.25, h: 4.25 },
  "6x9": { w: 9.25, h: 6.25 },
  "6x11": { w: 11.25, h: 6.25 },
};
const MAILER_DIMS: Dims = { w: 18.25, h: 6.25 }; // 6x18 bifold, folds to 6x9
const FORMAT_BY_TIER: Record<string, string> = { common: "4x6", rare: "6x9", epic: "6x11", legendary: "6x18_bifold" };
const formatFor = (tier?: string | null) => FORMAT_BY_TIER[tier ?? "common"] ?? "4x6";

const head = (fontsQ: string) =>
  `<head><link href="https://fonts.googleapis.com/css2?family=${fontsQ}&family=Inter:wght@600;700;800&display=swap" rel="stylesheet"></head>`;
// Every layout is drawn on a 6.25 x 4.25in base and scaled up to the real size.
// On wider cards, `strip` fills the extra space on the right.
const page = (fontsQ: string, body: string, bg: string, dims: Dims = POSTCARD_DIMS["4x6"], strip = "", overlay = "") => {
  const k = dims.h / 4.25;
  const baseW = 6.25 * k;
  const extra = dims.w - baseW;
  return `<html>${head(fontsQ)}<body style="margin:0;width:${dims.w}in;height:${dims.h}in;background:${bg};position:relative;overflow:hidden;">
<div style="position:absolute;left:0;top:0;width:6.25in;height:4.25in;transform:scale(${k.toFixed(4)});transform-origin:0 0;overflow:hidden;">${body}</div>
${strip && extra > 0.2 ? `<div style="position:absolute;left:${baseW.toFixed(3)}in;top:0;width:${extra.toFixed(3)}in;height:${dims.h}in;overflow:hidden;">${strip}</div>` : ""}
${overlay ? `<div style="position:absolute;inset:0;pointer-events:none;">${overlay}</div>` : ""}
</body></html>`;
};
const cover = (src: string, css: string) =>
  `<div style="position:absolute;${css};background:url('${src}') center/cover no-repeat;"></div>`;

const HEADLINE_BY_TIER: Record<string, string> = {
  common: "thank you for showing up.",
  rare: "you're a real one.",
  epic: "you're a legend.",
  legendary: "you're one of one.",
};

// Shared pieces for one card, computed once.
function cardKit(c: CardInfo) {
  const d = c.design || {};
  const accent = safeColor(d.accent_color, "#2BB3AA");
  const bg = safeColor(d.background_color, "#0F1B24");
  const st = styleFrom(typeof d.style_seed === "number" ? d.style_seed : hashString(c.styleKey));
  const F = st.fonts;
  const pt = (base: number, k: number) => `${(base * k).toFixed(1)}pt`;
  const s = esc(c.streamer), f = esc(c.supporter), r = esc(c.reward), num = esc(c.number);
  const message = esc((d.message || DEFAULT_MESSAGE).replaceAll("{name}", c.supporter));
  const logo = safeImg(d.logo_url), sig = safeImg(d.signature_url), frontImg = safeImg(d.front_url);
  const photos = (d.photo_urls ?? []).map(safeImg).filter(Boolean);
  if (!photos.length && safeImg(c.avatar)) photos.push(safeImg(c.avatar));
  // Each card in the month uses the next photo, so supporters don't all get the same card.
  const rot = Math.max(0, (c.cardIndex || 1) - 1);
  const pick = (i: number) => photos[(rot + i) % photos.length];
  let template = d.template || "photo";
  if (!photos.length) template = "classic";
  const headline = HEADLINE_BY_TIER[c.tier ?? "common"] ?? HEADLINE_BY_TIER.common;

  const pattern = (color: string) => `<div style="position:absolute;inset:0;${patternCss(st.pattern, color)}pointer-events:none;"></div>`;
  const logoOr = (size: string, color: string) => logo
    ? `<img src="${logo}" style="max-height:${size};max-width:2.2in;display:block">`
    : `<div style="font-family:${F.headCss};font-size:${pt(18, F.headSize)};color:${color};">${s}</div>`;
  const giftFor = (color: string) =>
    `<div style="font-family:Inter,Arial,sans-serif;font-weight:800;font-size:9pt;letter-spacing:2.5px;color:${color};">A GIFT FOR ${f.toUpperCase()}</div>`;
  const numberPill = (css: string) =>
    `<div style="position:absolute;${css};font-family:Inter,Arial,sans-serif;font-weight:800;font-size:8pt;letter-spacing:1px;color:#0F1B24;background:${accent};padding:0.05in 0.12in;border-radius:0.2in;">${num}</div>`;
  const title = (size: number, extra = "") =>
    `<div style="font-family:${F.headCss};font-size:${pt(size, F.headSize)};line-height:1.05;margin-top:0.08in;${extra}">${r}</div>`;
  const from = (size: number, color: string) =>
    `<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(size, F.handSize)};margin-top:0.06in;color:${color};">from ${s}</div>`;
  return { d, accent, bg, st, F, pt, s, f, r, num, message, logo, sig, frontImg, photos, rot, pick, template, headline,
    pattern, logoOr, giftFor, numberPill, title, from };
}

// Front of the card, drawn on the 6.25 x 4.25in base.
// Frame and rarity border are drawn by cardHtml over the whole card, so they also wrap wide cards.
function frontBody(c: CardInfo, K: ReturnType<typeof cardKit>): string {
  const { accent, bg, F, pt, f, s, pick, photos, template, pattern, logoOr, giftFor, numberPill, title, from, headline } = K;
  if (K.frontImg) return ""; // drawn full-size by cardHtml
  if (template === "photo") {
    return cover(pick(0), "inset:0") + pattern(accent) +
      `<div style="position:absolute;inset:0;background:linear-gradient(to top, rgba(10,16,22,.92) 0%, rgba(10,16,22,.55) 38%, rgba(10,16,22,0) 68%);"></div>` +
      `<div style="position:absolute;left:0.45in;top:0.4in;">${logoOr("0.65in", "#FFFFFF")}</div>` +
      numberPill("right:0.4in;top:0.42in") +
      `<div style="position:absolute;left:0.45in;right:0.45in;bottom:0.42in;color:#FFFFFF;">${giftFor(accent)}${title(28)}${from(19, "#F7F5F0")}</div>`;
  }
  if (template === "bold") {
    // One huge personal line over the photo, on a solid color panel.
    return cover(pick(0), "inset:0") +
      `<div style="position:absolute;left:0;top:0;bottom:0;width:3.7in;background:${bg};clip-path:polygon(0 0,100% 0,82% 100%,0 100%);"></div>` +
      `<div style="position:absolute;left:0;top:0;bottom:0;width:3.7in;clip-path:polygon(0 0,100% 0,82% 100%,0 100%);">${pattern(accent)}</div>` +
      `<div style="position:absolute;left:0.42in;top:0.42in;width:2.75in;color:#FFFFFF;">
<div style="font-family:${F.headCss};font-size:${pt(30, F.headSize)};line-height:1.02;">Hey ${f},</div>
<div style="font-family:${F.headCss};font-size:${pt(30, F.headSize)};line-height:1.02;color:${accent};">${headline}</div></div>` +
      `<div style="position:absolute;left:0.42in;bottom:0.42in;width:2.6in;color:#F7F5F0;">
<div style="font-family:Inter,Arial,sans-serif;font-weight:800;font-size:8pt;letter-spacing:2px;color:${accent};">${esc(c.reward).toUpperCase()}</div>
${from(18, "#F7F5F0")}<div style="margin-top:0.12in;">${logoOr("0.45in", "#FFFFFF")}</div></div>` +
      numberPill("right:0.35in;bottom:0.35in");
  }
  if (template === "editorial") {
    // Tall photo, color column with the streamer's name running vertically, magazine-style.
    return `<div style="position:absolute;inset:0;background:${bg};"></div>` + pattern(accent) +
      cover(pick(0), "left:2.25in;top:0;right:0;bottom:0") +
      `<div style="position:absolute;left:2.25in;top:0;bottom:0;width:0.06in;background:${accent};"></div>` +
      `<div style="position:absolute;left:0.28in;top:0.35in;bottom:0.35in;width:0.9in;writing-mode:vertical-rl;transform:rotate(180deg);font-family:${F.headCss};font-size:${pt(40, F.headSize)};line-height:0.9;color:#FFFFFF;white-space:nowrap;overflow:hidden;">${s}</div>` +
      `<div style="position:absolute;left:1.2in;top:0.4in;width:0.95in;color:#F7F5F0;">${logoOr("0.45in", "#FFFFFF")}</div>` +
      `<div style="position:absolute;left:1.2in;bottom:0.42in;width:0.98in;color:#F7F5F0;">
<div style="font-family:Inter,Arial,sans-serif;font-weight:800;font-size:6.5pt;letter-spacing:1.5px;color:${accent};line-height:1.4;">A GIFT<br>FOR ${f.toUpperCase()}</div>
<div style="font-family:${F.headCss};font-size:${pt(13, F.headSize)};line-height:1.05;margin-top:0.06in;">${K.r}</div>
<div style="font-family:Inter,Arial,sans-serif;font-weight:700;font-size:6.5pt;margin-top:0.1in;color:#BFD0D6;">${K.num}</div></div>`;
  }
  if (template === "collage") {
    const p = [pick(0), pick(1), pick(2)];
    const count = Math.min(photos.length, 3);
    const left = count >= 3
      ? cover(p[0], "left:0;top:0;width:2.3in;height:4.25in") +
        cover(p[1], "left:2.36in;top:0;width:1.64in;height:2.095in") +
        cover(p[2], "left:2.36in;top:2.155in;width:1.64in;height:2.095in")
      : count === 2
      ? cover(p[0], "left:0;top:0;width:1.97in;height:4.25in") + cover(p[1], "left:2.03in;top:0;width:1.97in;height:4.25in")
      : cover(p[0], "left:0;top:0;width:4in;height:4.25in");
    return `<div style="position:absolute;inset:0;background:#FFFFFF;"></div>` + left +
      `<div style="position:absolute;left:4.06in;top:0;right:0;bottom:0;background:${bg};overflow:hidden;">${pattern(accent)}</div>` +
      `<div style="position:absolute;left:4.06in;top:0;right:0;bottom:0;color:#F7F5F0;padding:0.4in 0.25in;box-sizing:border-box;">
${logoOr("0.55in", "#FFFFFF")}
<div style="margin-top:0.3in;">${giftFor(accent)}</div>${title(17)}${from(16, "#F7F5F0")}</div>` +
      numberPill("right:0.25in;bottom:0.35in");
  }
  const circle = photos.length
    ? `<div style="position:absolute;right:0.4in;top:0.85in;width:2.2in;height:2.2in;border-radius:50%;border:0.08in solid ${accent};background:url('${pick(0)}') center/cover no-repeat;"></div>`
    : "";
  return pattern(accent) + circle +
    `<div style="position:absolute;left:0.5in;top:0.45in;width:${circle ? "2.85in" : "5.2in"};color:#F7F5F0;">
${logoOr("0.8in", "#FFFFFF")}
<div style="margin-top:0.35in;">${giftFor(accent)}</div>${title(circle ? 22 : 26)}${from(19, "#F7F5F0")}</div>` +
    numberPill("left:0.5in;bottom:0.4in");
}

// Back of a postcard, drawn on the 6.25 x 4.25in base. Everything stays left of x = 2.6in:
// the printer's no-ink address zone starts at 2.69in on a 4x6 (and further right when scaled up).
function backBody(c: CardInfo, K: ReturnType<typeof cardKit>): string {
  const { accent, F, pt, f, s, num, message, sig, photos, pick, rot, st } = K;
  const backPhoto = photos.length ? pick(photos.length > 1 ? 1 : 0) : "";
  const polaroid = backPhoto
    ? `<div style="position:absolute;left:0.36in;top:0.3in;width:0.95in;padding:0.055in 0.055in 0.18in;background:#FFFFFF;box-shadow:0 0.02in 0.08in rgba(0,0,0,.25);transform:rotate(${(rot % 2 ? 3 : -4)}deg);">
<div style="width:0.95in;height:0.95in;background:url('${backPhoto}') center/cover no-repeat;"></div></div>`
    : "";
  const headLeft = polaroid ? "1.52in" : "0.38in";
  return `<div style="position:absolute;left:0;top:0;bottom:0;width:0.12in;background:${accent};"></div>` +
    `<div style="position:absolute;left:0.12in;top:0;bottom:0;width:2.45in;${patternCss(st.pattern, accent)}opacity:.3;"></div>` +
    polaroid +
    `<div style="position:absolute;left:${headLeft};top:0.38in;width:${polaroid ? "1.5in" : "2.2in"};">
<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(22, F.handSize)};line-height:1;color:#1B2B35;">Hey ${f},</div>
${c.statLine ? `<div style="font-family:Inter,Arial,sans-serif;font-size:7.5pt;font-weight:700;line-height:1.3;margin-top:0.08in;color:${accent};">${esc(c.statLine)}</div>` : ""}
</div>
<div style="position:absolute;left:0.38in;top:${polaroid ? "1.58in" : "1.15in"};width:2.2in;font-family:${F.handCss};font-weight:600;font-size:${pt(13.5, F.handSize)};line-height:1.2;color:#1B2B35;">${message}</div>
<div style="position:absolute;left:0.38in;bottom:0.3in;width:2.2in;">
${sig ? `<img src="${sig}" style="max-height:0.55in;max-width:1.9in;display:block;mix-blend-mode:multiply">` : `<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(20, F.handSize)};color:#1B2B35;">${s}</div>`}
<div style="font-family:Inter,Arial,sans-serif;font-size:7pt;color:#5A6A72;margin-top:0.03in;">&mdash; ${s} &nbsp;·&nbsp; ${num}</div></div>`;
}

// A postcard at the size its rarity calls for (4x6, 6x9 or 6x11).
function cardHtml(c: CardInfo, size = "4x6") {
  const K = cardKit(c);
  const dims = POSTCARD_DIMS[size] ?? POSTCARD_DIMS["4x6"];
  // Extra width on 6x11: another photo on the front, plain paper on the back (address side).
  const strip = K.photos.length
    ? cover(K.pick(1), "inset:0") + `<div style="position:absolute;left:0;top:0;bottom:0;width:0.06in;background:${K.accent};"></div>`
    : `<div style="position:absolute;inset:0;background:${K.bg};">${K.pattern(K.accent)}</div>`;
  const overlay = (K.frontImg ? "" : frameHtml(K.st.frame, K.accent)) + tierHtml(c.tier, K.accent);
  const front = K.frontImg
    ? page(K.F.q, "", K.bg, dims, "", cover(K.frontImg, "inset:0") + overlay)
    : page(K.F.q, frontBody(c, K), K.bg, dims, strip, overlay);
  const back = page(K.F.q, backBody(c, K), "#FFFFFF", dims);
  return { front, back };
}

// Legendary gifts: a 6x18 bifold mailer that folds to 6x9 and opens like a booklet.
// Outside = [address panel | cover]. Inside = [photo spread | letter].
function mailerHtml(c: CardInfo) {
  const K = cardKit(c);
  const { accent, bg, F, pt, f, s, r, num, message, sig, photos, pick, logo } = K;
  const W = MAILER_DIMS.w, H = MAILER_DIMS.h, P = W / 2; // each panel ~9.125in
  const logoTag = (h: string, color: string) => logo
    ? `<img src="${logo}" style="max-height:${h};max-width:3in;display:block">`
    : `<div style="font-family:${F.headCss};font-size:${pt(24, F.headSize)};color:${color};">${s}</div>`;
  const wrap = (body: string) =>
    `<html>${head(F.q)}<body style="margin:0;width:${W}in;height:${H}in;position:relative;overflow:hidden;background:#FFFFFF;">${body}</body></html>`;

  // Left outside panel: white, branding at the top only. The no-ink address zone is the
  // bottom-right of this panel (4 x 2.375in, 0.15in from the fold, 0.25in from the bottom).
  const outside = wrap(
    `<div style="position:absolute;left:0;top:0;width:${P}in;height:0.18in;background:${accent};"></div>
<div style="position:absolute;left:0.5in;top:0.55in;width:${P - 1}in;">
${logoTag("0.7in", "#1B2B35")}
<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(26, F.handSize)};color:#1B2B35;margin-top:0.25in;">${f}, something special is inside.</div>
<div style="font-family:Inter,Arial,sans-serif;font-weight:700;font-size:9pt;letter-spacing:2px;color:${accent};margin-top:0.12in;">FROM ${s.toUpperCase()} · ${num.toUpperCase()}</div></div>` +
    // Cover panel
    `<div style="position:absolute;left:${P}in;top:0;width:${P}in;height:${H}in;background:${bg};overflow:hidden;">
${photos.length ? cover(pick(0), "inset:0") : K.pattern(accent)}
<div style="position:absolute;inset:0;background:linear-gradient(to top, rgba(10,16,22,.92) 0%, rgba(10,16,22,.45) 45%, rgba(10,16,22,0) 75%);"></div>
<div style="position:absolute;inset:0;border:0.16in solid transparent;border-image:linear-gradient(135deg,#F6E27A,#B8862B,#FFF4C2,#A8741A,#F6E27A) 1;"></div>
<div style="position:absolute;left:50%;top:0.3in;transform:translateX(-50%);background:linear-gradient(90deg,#B8862B,#F6E27A,#B8862B);color:#2A1E05;font-family:Inter,Arial,sans-serif;font-weight:800;font-size:9pt;letter-spacing:3px;padding:0.05in 0.2in;border-radius:0.15in;">LEGENDARY</div>
<div style="position:absolute;left:0.6in;right:0.6in;bottom:0.6in;color:#FFFFFF;">
<div style="font-family:Inter,Arial,sans-serif;font-weight:800;font-size:11pt;letter-spacing:3px;color:${accent};">A GIFT FOR ${f.toUpperCase()}</div>
<div style="font-family:${F.headCss};font-size:${pt(44, F.headSize)};line-height:1.02;margin-top:0.1in;">${r}</div>
<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(28, F.handSize)};margin-top:0.08in;">from ${s}</div></div></div>`);

  // Inside: left panel = photo spread, right panel = the letter.
  const p = photos.length ? [pick(0), pick(1), pick(2)] : [];
  const spread = p.length
    ? cover(p[0], `left:0;top:0;width:${(P * 0.6).toFixed(2)}in;height:${H}in`) +
      cover(p[1], `left:${(P * 0.6 + 0.06).toFixed(2)}in;top:0;right:0;height:${(H / 2 - 0.03).toFixed(2)}in`) +
      cover(p[2], `left:${(P * 0.6 + 0.06).toFixed(2)}in;top:${(H / 2 + 0.03).toFixed(2)}in;right:0;bottom:0`)
    : `<div style="position:absolute;inset:0;background:${bg};">${K.pattern(accent)}</div>`;
  const inside = wrap(
    `<div style="position:absolute;left:0;top:0;width:${P}in;height:${H}in;background:#FFFFFF;overflow:hidden;">${spread}</div>` +
    `<div style="position:absolute;left:${P}in;top:0;width:${P}in;height:${H}in;background:#FFFFFF;overflow:hidden;">
<div style="position:absolute;inset:0;${patternCss(K.st.pattern, accent)}opacity:.25;"></div>
<div style="position:absolute;left:0;top:0;bottom:0;width:0.1in;background:${accent};"></div>
<div style="position:absolute;left:0.75in;top:0.6in;right:0.75in;">
<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(40, F.handSize)};line-height:1;color:#1B2B35;">Hey ${f},</div>
<div style="font-family:${F.handCss};font-weight:600;font-size:${pt(22, F.handSize)};line-height:1.25;color:#1B2B35;margin-top:0.2in;max-width:6.4in;">${message}</div>
${c.statLine ? `<div style="display:inline-block;margin-top:0.3in;font-family:Inter,Arial,sans-serif;font-weight:800;font-size:12pt;color:#0F1B24;background:${accent};padding:0.08in 0.18in;border-radius:0.1in;">${esc(c.statLine)}</div>` : ""}
</div>
<div style="position:absolute;left:0.75in;bottom:0.55in;">
${sig ? `<img src="${sig}" style="max-height:0.9in;max-width:3in;display:block;mix-blend-mode:multiply">` : `<div style="font-family:${F.handCss};font-weight:700;font-size:${pt(32, F.handSize)};color:#1B2B35;">${s}</div>`}
<div style="font-family:Inter,Arial,sans-serif;font-size:9pt;color:#5A6A72;margin-top:0.05in;">&mdash; ${s} &nbsp;·&nbsp; ${num}</div></div>
<div style="position:absolute;right:0.6in;bottom:0.55in;">${logoTag("0.6in", "#1B2B35")}</div>
</div>`);
  return { outside, inside };
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Builds the personal details for one claim: their stat line and this card's number.
async function cardInfoForClaim(claim: any): Promise<CardInfo> {
  const reward = claim.rewards as any;
  const supporter = claim.supporters as any;
  const streamerId = claim.streamer_id;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const monthName = MONTHS[now.getUTCMonth()];

  const [{ data: design }, { data: events }, { count }] = await Promise.all([
    db.from("card_designs").select("*").eq("streamer_id", streamerId).maybeSingle(),
    db.from("supporter_events").select("event_type, quantity, occurred_at").eq("supporter_id", claim.supporter_id),
    db.from("claims").select("id", { count: "exact", head: true })
      .eq("streamer_id", streamerId).gte("created_at", monthStart).lte("created_at", claim.created_at),
  ]);

  const ev = events ?? [];
  const giftsThisMonth = ev.filter((e: any) => e.event_type === "gift_sub" && e.occurred_at >= monthStart)
    .reduce((n: number, e: any) => n + (e.quantity || 0), 0);
  const giftsAllTime = ev.filter((e: any) => e.event_type === "gift_sub").reduce((n: number, e: any) => n + (e.quantity || 0), 0);
  const subMonths = ev.filter((e: any) => e.event_type === "resub").reduce((m: number, e: any) => Math.max(m, e.quantity || 0), 0);
  const first = ev.map((e: any) => e.occurred_at).sort()[0];

  const rule = reward?.unlock_rule?.type;
  let statLine = "";
  if (rule === "gift_subs" && giftsThisMonth) statLine = `You gifted ${giftsThisMonth} subs in ${monthName}.`;
  else if (rule === "gift_subs" && giftsAllTime) statLine = `You've gifted ${giftsAllTime} subs to this community.`;
  else if (rule === "sub_months" && subMonths) statLine = `${subMonths} months subscribed. That's loyalty.`;
  else if (rule === "watch_hours") statLine = "Hours and hours on stream with us.";
  else if (first) {
    const d = new Date(first);
    statLine = `Supporting since ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}.`;
  }

  return {
    streamer: (claim.streamers as any)?.display_name ?? "the stream",
    avatar: (claim.streamers as any)?.avatar_url ?? null,
    supporter: supporter?.display_name ?? "friend",
    reward: reward?.name ?? "A thank-you",
    statLine,
    number: `#${count ?? 1} · ${monthName} ${now.getUTCFullYear()}`,
    cardIndex: count ?? 1,
    tier: reward?.tier ?? null,
    styleKey: streamerId,
    design: design ?? {},
  };
}

const lobAuth = () => "Basic " + btoa(`${LOB_API_KEY}:`);

// Return address = our mailing address, but with the streamer's name on it.
async function streamerFromAddress(streamerName: string) {
  const res = await fetch(`https://api.lob.com/v1/addresses/${LOB_FROM_ADDRESS_ID}`, { headers: { Authorization: lobAuth() } });
  if (!res.ok) return LOB_FROM_ADDRESS_ID;
  const a = await res.json();
  return {
    name: streamerName.slice(0, 40),
    address_line1: a.address_line1, address_line2: a.address_line2 || undefined,
    address_city: a.address_city, address_state: a.address_state,
    address_zip: a.address_zip, address_country: a.address_country || "US",
  };
}

function lobTo(addr: Record<string, string | null>) {
  return {
    name: addr.full_name,
    address_line1: addr.line1,
    address_line2: addr.line2 || undefined,
    address_city: addr.city,
    address_state: addr.region,
    address_zip: addr.postal_code,
    address_country: addr.country,
  };
}

async function sendLobSelfMailer(addr: Record<string, string | null>, html: { outside: string; inside: string }, fromAddress: unknown) {
  const res = await fetch("https://api.lob.com/v1/self_mailers", {
    method: "POST",
    headers: { Authorization: lobAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      to: lobTo(addr), from: fromAddress, outside: html.outside, inside: html.inside,
      size: "6x18_bifold", use_type: "marketing",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lob ${res.status}: ${JSON.stringify(data?.error ?? data)}`);
  return data as { id: string };
}

async function sendLobPostcard(addr: Record<string, string | null>, html: { front: string; back: string }, fromAddress: unknown, size = "4x6") {
  const res = await fetch("https://api.lob.com/v1/postcards", {
    method: "POST",
    headers: { Authorization: lobAuth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      to: lobTo(addr), from: fromAddress, front: html.front, back: html.back,
      size, use_type: "marketing",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lob ${res.status}: ${JSON.stringify(data?.error ?? data)}`);
  return data as { id: string; url?: string };
}

// ---------- Posters: Printful ----------
async function printful(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${PRINTFUL_API_KEY}`, "Content-Type": "application/json" };
  if (PRINTFUL_STORE_ID) headers["X-PF-Store-Id"] = PRINTFUL_STORE_ID;
  const res = await fetch(`https://api.printful.com${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Printful ${res.status}: ${JSON.stringify(data?.error ?? data?.result ?? data)}`);
  return data.result;
}

// Find the catalog variant for a poster size like "18x24" (Printful names it 18″×24″).
async function posterVariantId(size: string): Promise<number> {
  const [w, h] = size.split("x");
  const product = await printful(`/products/${PRINTFUL_POSTER_PRODUCT_ID}`);
  const match = (product?.variants ?? []).find((v: any) => {
    const nums = String(v.size ?? v.name ?? "").match(/\d+(\.\d+)?/g) ?? [];
    return nums.includes(w) && nums.includes(h);
  });
  if (!match) throw new Error(`No Printful poster variant for ${size}`);
  return match.id;
}

async function sendPrintfulPoster(addr: Record<string, string | null>, artworkUrl: string, size: string, externalId: string) {
  const variantId = await posterVariantId(size);
  const order = await printful(`/orders${PRINTFUL_AUTO_CONFIRM ? "?confirm=true" : ""}`, {
    method: "POST",
    body: JSON.stringify({
      external_id: externalId.replace(/-/g, "").slice(0, 32),
      recipient: {
        name: addr.full_name, address1: addr.line1, address2: addr.line2 || undefined,
        city: addr.city, state_code: addr.region || undefined, country_code: addr.country, zip: addr.postal_code,
      },
      items: [{ variant_id: variantId, quantity: 1, files: [{ url: artworkUrl }] }],
    }),
  });
  return { id: String(order.id) };
}

// ---------- Pen-written cards: Simply Noted ----------
async function sendSimplyNotedCard(addr: Record<string, string | null>, info: CardInfo) {
  const d = info.design || {};
  const msg = (d.message || DEFAULT_MESSAGE).replaceAll("{name}", info.supporter);
  // Robots write this in real ink, so keep it short enough to fit a note card.
  const body = `Hey ${info.supporter},\n\n${msg}${info.statLine ? `\n\n${info.statLine}` : ""}\n\n- ${info.streamer}`.slice(0, 600);
  const parts = String(addr.full_name ?? "").trim().split(/\s+/);
  const res = await fetch("https://live.simplynoted.com/api/v2/single_card_mailings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": SN_API_KEY, "x-user-id": SN_USER_ID },
    body: JSON.stringify({
      single_card_mailing: {
        card_id: SN_CARD_ID,
        sender_profile_id: SN_SENDER_ID,
        message_body: body,
        name: `${SN_TEST ? "Do Not Mail - " : ""}Clicktide ${info.streamer} to ${info.supporter} ${info.number}`.slice(0, 120),
        contact: {
          first_name: parts[0] ?? "", last_name: parts.slice(1).join(" "),
          street_1: addr.line1, street_2: addr.line2 || undefined,
          city: addr.city, state: addr.region, zipcode: addr.postal_code,
        },
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Simply Noted ${res.status}: ${JSON.stringify(data)}`);
  return { id: String(data?.id ?? data?.single_card_mailing?.id ?? data?.data?.id ?? "sent") };
}

const ADDRESS_FIELDS = "full_name, line1, line2, city, region, postal_code, country";

// The platform account id of whoever sent this request, or "" if not logged in.
async function loggedInPlatformId(req: Request, platform: string): Promise<string> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.split(".").length !== 3) return "";
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return "";
  const identity = data.user.identities?.find((i) => i.provider === platform);
  const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;
  return identity ? String(idData.provider_id ?? idData.sub ?? identity.id) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  await db.rpc("expire_claims");

  // Streamer dashboard preview: GET ?preview=1 with the streamer's login -> sample card HTML.
  if (req.method === "GET" && new URL(req.url).searchParams.get("preview") === "1") {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Log in" }, 401);
    const { data: st } = await db.from("streamers").select("id, display_name, avatar_url").eq("owner_user_id", u.user.id).maybeSingle();
    if (!st) return json({ error: "Connect your channel first" }, 404);
    const { data: design } = await db.from("card_designs").select("*").eq("streamer_id", st.id).maybeSingle();
    const now = new Date();
    const q = new URL(req.url).searchParams;
    const n = Math.min(999, Math.max(1, Number(q.get("n")) || 12));
    const tier = ["common", "rare", "epic", "legendary"].includes(q.get("tier") ?? "") ? q.get("tier") : "common";
    const sample: Record<string, string> = { common: "Thank-you postcard", rare: "Day One card", epic: "Earned-only card", legendary: "Legend card" };
    const seedParam = q.get("seed");
    const d = { ...(design ?? {}) };
    if (seedParam !== null && /^\d{1,9}$/.test(seedParam)) d.style_seed = Number(seedParam);
    const info: CardInfo = {
      streamer: st.display_name, avatar: st.avatar_url, supporter: "Jordan", reward: sample[tier!],
      statLine: `You gifted 25 subs in ${MONTHS[now.getUTCMonth()]}.`,
      number: `#${n} · ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`,
      cardIndex: n, tier, styleKey: st.id, design: d,
    };
    const fmt = formatFor(tier);
    const style = styleFrom(typeof d.style_seed === "number" ? d.style_seed : hashString(st.id));
    if (fmt === "6x18_bifold") {
      const m = mailerHtml(info);
      return json({ front: m.outside, back: m.inside, format: fmt, dims: MAILER_DIMS, labels: ["Outside", "Inside (opened)"], style, styles: STYLE_COUNT });
    }
    const html = cardHtml(info, fmt);
    return json({ ...html, format: fmt, dims: POSTCARD_DIMS[fmt], labels: ["Front", "Back"], style, styles: STYLE_COUNT });
  }

  if (req.method === "GET") {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    if (!UUID_RE.test(token)) return json({ error: "Invalid link" }, 400);
    const { data: claim, error } = await loadClaim(token);
    if (error) return json({ error: "Lookup failed" }, 500);
    if (!claim) return json({ error: "This link doesn't exist" }, 404);
    const reward = claim.rewards as any;
    const supporter = claim.supporters as any;
    // Only the supporter who earned it ever gets their saved address back.
    let saved_address = null;
    let is_owner = false;
    const me = await loggedInPlatformId(req, supporter?.platform);
    if (me && me === supporter?.platform_user_id) {
      is_owner = true;
      const { data: addr } = await db
        .from("supporter_addresses")
        .select(ADDRESS_FIELDS)
        .eq("platform", supporter.platform)
        .eq("platform_user_id", supporter.platform_user_id)
        .maybeSingle();
      saved_address = addr ?? null;
    }
    return json({
      status: claim.status,
      expires_at: claim.expires_at,
      // No item name here: supporters see "a gift" so it stays a surprise.
      streamer: (claim.streamers as any)?.display_name,
      supporter: supporter?.display_name,
      platform: supporter?.platform,
      needs_size: SIZED_ITEMS.has(reward?.item_type),
      is_owner,
      saved_address,
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const token = clean(body.token, 64);
  if (!UUID_RE.test(token)) return json({ error: "Invalid link" }, 400);

  const { data: claim, error } = await loadClaim(token);
  if (error) return json({ error: "Lookup failed" }, 500);
  if (!claim) return json({ error: "This link doesn't exist" }, 404);
  if (claim.status !== "pending") return json({ error: `This gift is already ${claim.status}` }, 409);

  // The logged-in account must be the supporter who earned it.
  const supporter = claim.supporters as any;
  const loggedInId = await loggedInPlatformId(req, supporter?.platform);
  if (!loggedInId) return json({ error: "Log in to claim" }, 401);
  if (loggedInId !== supporter?.platform_user_id) {
    return json({ error: "Log in with the account that earned this gift" }, 403);
  }

  if (body.age_confirmed !== true) return json({ error: "Please confirm the age checkbox" }, 400);

  const reward = claim.rewards as any;
  let size: string | null = null;
  if (SIZED_ITEMS.has(reward?.item_type)) {
    size = clean(body.size, 4).toUpperCase();
    if (!SIZES.has(size)) return json({ error: "Pick a size" }, 400);
  }

  const a = body.address ?? {};
  const address = {
    full_name: clean(a.full_name, 80),
    line1: clean(a.line1, 120),
    line2: clean(a.line2, 120) || null,
    city: clean(a.city, 80),
    region: clean(a.region, 40) || null,
    postal_code: clean(a.postal_code, 20),
    country: (clean(a.country, 2) || "US").toUpperCase(),
  };
  if (!address.full_name || !address.line1 || !address.city || !address.postal_code) {
    return json({ error: "Fill in name, street, city and ZIP" }, 400);
  }
  if (address.country === "US" && !address.region) return json({ error: "Add your state" }, 400);

  // Lock the claim first so it can't be claimed twice.
  const { data: locked, error: lockErr } = await db
    .from("claims")
    .update({ status: "claimed", size })
    .eq("id", claim.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (lockErr) return json({ error: "Could not claim" }, 500);
  if (!locked) return json({ error: "This gift was already claimed" }, 409);

  const { error: addrErr } = await db
    .from("claim_addresses")
    .insert({ claim_id: claim.id, ...address, age_confirmed: true });
  if (addrErr) {
    await db.from("claims").update({ status: "pending", size: null }).eq("id", claim.id);
    return json({ error: "Could not save address" }, 500);
  }

  // Remember it for their next gift (they can untick this on the claim page).
  if (body.save_address !== false) {
    const { error: saveErr } = await db.from("supporter_addresses").upsert(
      { platform: supporter.platform, platform_user_id: supporter.platform_user_id, ...address },
      { onConflict: "platform,platform_user_id" },
    );
    if (saveErr) console.error("Saving address for next time failed", saveErr);
  }

  // Send the gift to whoever makes it. If a company isn't set up yet, or fails, the claim
  // stays "claimed" with the address saved, so it can be sent later.
  const type = reward?.item_type;
  try {
    if (type === "postcard" && LOB_API_KEY && LOB_FROM_ADDRESS_ID) {
      const info = await cardInfoForClaim(claim);
      const fmt = formatFor(info.tier);
      const fromAddr = await streamerFromAddress(info.streamer);
      const order = fmt === "6x18_bifold"
        ? await sendLobSelfMailer(address, mailerHtml(info), fromAddr)
        : await sendLobPostcard(address, cardHtml(info, fmt), fromAddr, fmt);
      await db.from("claims").update({ status: "ordered", provider: "lob", provider_order_id: order.id }).eq("id", claim.id);
      return json({ status: "ordered" });
    }
    if (type === "handwritten_card" && SN_API_KEY && SN_USER_ID && SN_CARD_ID && SN_SENDER_ID) {
      const info = await cardInfoForClaim(claim);
      const order = await sendSimplyNotedCard(address, info);
      await db.from("claims").update({ status: "ordered", provider: "simplynoted", provider_order_id: order.id }).eq("id", claim.id);
      return json({ status: "ordered" });
    }
    if (type === "poster" && PRINTFUL_API_KEY) {
      const { data: design } = await db.from("card_designs").select("poster_url, poster_size").eq("streamer_id", claim.streamer_id).maybeSingle();
      const art = design?.poster_url && design.poster_url.startsWith(STORAGE_PREFIX) ? design.poster_url : "";
      if (art) {
        const order = await sendPrintfulPoster(address, art, design!.poster_size || "18x24", claim.id);
        const status = PRINTFUL_AUTO_CONFIRM ? "ordered" : "claimed"; // drafts wait for your approval in Printful
        await db.from("claims").update({ status, provider: "printful", provider_order_id: order.id }).eq("id", claim.id);
        return json({ status });
      }
    }
  } catch (err) {
    console.error(`${type} send failed`, err);
    return json({ status: "claimed", note: "Saved. It will be sent shortly." });
  }

  return json({ status: "claimed" });
});
