// Receives Twitch EventSub webhooks (subs, resubs, gift subs, bits, channel point
// redemptions, stream online/offline), verifies Twitch's signature, records the
// event, and creates any claims the supporter just unlocked.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = Deno.env.get("TWITCH_EVENTSUB_SECRET") ?? "";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const enc = new TextEncoder();

// What the streamer keeps per sub, in cents, by Twitch tier (approximate).
const TIER_CENTS: Record<string, number> = { "1000": 250, "2000": 500, "3000": 1250 };

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const done = () => new Response(null, { status: 204 });

type SupporterEvent = {
  userId: string;
  userName: string | null;
  type: string;
  cents: number;
  qty: number;
  rewardId: string | null;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SECRET) return new Response("TWITCH_EVENTSUB_SECRET is not set", { status: 500 });

  const messageId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = req.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = req.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  const messageType = req.headers.get("Twitch-Eventsub-Message-Type") ?? "";
  const body = await req.text();

  const expected = "sha256=" + (await hmacHex(SECRET, messageId + timestamp + body));
  if (!messageId || !safeEqual(expected, signature)) {
    return new Response("Bad signature", { status: 403 });
  }
  const ageMs = Date.now() - Date.parse(timestamp);
  if (!(ageMs >= -60_000 && ageMs < 10 * 60_000)) {
    return new Response("Stale message", { status: 403 });
  }

  let msg: any;
  try {
    msg = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (messageType === "webhook_callback_verification") {
    return new Response(String(msg.challenge ?? ""), { headers: { "Content-Type": "text/plain" } });
  }
  if (messageType === "revocation") {
    console.warn("EventSub revoked", msg.subscription?.type, msg.subscription?.status);
    return done();
  }
  if (messageType !== "notification") return done();

  const subType: string = msg.subscription?.type ?? "";
  const e = msg.event ?? {};
  const broadcasterId: string | undefined = e.broadcaster_user_id;
  if (!broadcasterId) return done();

  const { data: streamer, error: streamerErr } = await db
    .from("streamers")
    .select("id")
    .eq("platform", "twitch")
    .eq("platform_user_id", broadcasterId)
    .maybeSingle();
  if (streamerErr) {
    console.error(streamerErr);
    return new Response("Lookup failed", { status: 500 });
  }
  if (!streamer) return done();

  // Live state drives the watch-time tracker's 5-minute chat roll call.
  if (subType === "stream.online") {
    await db.from("streamers").update({ is_live: true, live_since: new Date().toISOString() }).eq("id", streamer.id);
    return done();
  }
  if (subType === "stream.offline") {
    await db.from("streamers").update({ is_live: false }).eq("id", streamer.id);
    return done();
  }

  let ev: SupporterEvent | null = null;
  const tierCents = TIER_CENTS[e.tier as string] ?? 250;

  switch (subType) {
    case "channel.subscribe":
      // Gifted subs are credited to the gifter via channel.subscription.gift.
      if (e.is_gift) return done();
      ev = { userId: e.user_id, userName: e.user_name, type: "sub", cents: tierCents, qty: 1, rewardId: null };
      break;
    case "channel.subscription.message":
      ev = {
        userId: e.user_id, userName: e.user_name, type: "resub", cents: tierCents,
        qty: Number(e.cumulative_months) || 1, rewardId: null,
      };
      break;
    case "channel.subscription.gift": {
      if (e.is_anonymous || !e.user_id) return done();
      const total = Number(e.total) || 1;
      ev = { userId: e.user_id, userName: e.user_name, type: "gift_sub", cents: tierCents * total, qty: total, rewardId: null };
      break;
    }
    case "channel.cheer": {
      if (e.is_anonymous || !e.user_id) return done();
      const bits = Number(e.bits) || 0;
      ev = { userId: e.user_id, userName: e.user_name, type: "bits", cents: bits, qty: Math.max(bits, 1), rewardId: null };
      break;
    }
    case "channel.channel_points_custom_reward_redemption.add":
      ev = { userId: e.user_id, userName: e.user_name, type: "redemption", cents: 0, qty: 1, rewardId: e.reward?.id ?? null };
      break;
    default:
      return done();
  }

  if (!ev?.userId) return done();

  const { data: claims, error } = await db.rpc("record_supporter_event", {
    p_streamer_id: streamer.id,
    p_platform: "twitch",
    p_platform_user_id: String(ev.userId),
    p_display_name: ev.userName,
    p_event_type: ev.type,
    p_value_cents: ev.cents,
    p_quantity: ev.qty,
    p_platform_event_id: messageId,
    p_raw: { subscription_type: subType, event: e },
    p_platform_reward_id: ev.rewardId,
  });
  if (error) {
    console.error("record_supporter_event failed", error);
    return new Response("Record failed", { status: 500 }); // Twitch will retry
  }
  if (Array.isArray(claims) && claims.length > 0) {
    console.log(`Supporter ${ev.userName} unlocked ${claims.length} reward(s)`);
  }
  return done();
});
