// Viewer challenge progress: GET ?streamer=<id> -> the channel's active challenges.
// With the viewer's own Twitch login attached, also returns their personal progress
// and (only for the verified owner) a claim link token for unlocked rewards.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewerTwitchId(req: Request): Promise<{ id: string; name: string } | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.split(".").length !== 3) return null;
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  const identity = data.user.identities?.find((i) => i.provider === "twitch");
  if (!identity) return null;
  const idData = (identity.identity_data ?? {}) as Record<string, unknown>;
  return {
    id: String(idData.provider_id ?? idData.sub ?? identity.id),
    name: String(idData.nickname ?? idData.name ?? "you"),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const streamerId = new URL(req.url).searchParams.get("streamer") ?? "";
  if (!UUID_RE.test(streamerId)) return json({ error: "Unknown channel link" }, 400);

  const { data: streamer } = await db
    .from("streamers")
    .select("id, display_name, avatar_url, is_live")
    .eq("id", streamerId)
    .maybeSingle();
  if (!streamer) return json({ error: "This channel isn't on Clicktide yet" }, 404);

  const { data: rewards } = await db
    .from("rewards")
    .select("id, name, tier, item_type, unlock_rule")
    .eq("streamer_id", streamerId)
    .eq("active", true)
    .order("cost_cents");

  const viewer = await viewerTwitchId(req);
  let supporter: { id: string; watch_minutes: number; supporter_value_cents: number } | null = null;
  let sums = { gifts_month: 0, gifts_all: 0, bits_month: 0, bits_all: 0, sub_months: 0 };
  const claimByReward = new Map<string, { token: string | null; status: string }>();

  if (viewer) {
    const { data: sup } = await db
      .from("supporters")
      .select("id, watch_minutes, supporter_value_cents")
      .eq("streamer_id", streamerId)
      .eq("platform", "twitch")
      .eq("platform_user_id", viewer.id)
      .maybeSingle();
    supporter = sup ?? null;

    if (supporter) {
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
      const { data: events } = await db
        .from("supporter_events")
        .select("event_type, quantity, occurred_at")
        .eq("supporter_id", supporter.id);
      for (const e of events ?? []) {
        const q = Number(e.quantity) || 0;
        const inMonth = e.occurred_at >= monthStart;
        if (e.event_type === "gift_sub" || e.event_type === "gift_membership") {
          sums.gifts_all += q; if (inMonth) sums.gifts_month += q;
        } else if (e.event_type === "bits") {
          sums.bits_all += q; if (inMonth) sums.bits_month += q;
        } else if (e.event_type === "resub" || e.event_type === "member_milestone") {
          sums.sub_months = Math.max(sums.sub_months, q);
        }
      }
      const { data: claims } = await db
        .from("claims")
        .select("reward_id, status, claim_token, created_at")
        .eq("supporter_id", supporter.id)
        .not("status", "in", "(canceled,expired)")
        .order("created_at", { ascending: false });
      for (const c of claims ?? []) {
        if (!claimByReward.has(c.reward_id)) {
          claimByReward.set(c.reward_id, {
            token: c.status === "pending" ? c.claim_token : null, // owner verified by Twitch login above
            status: c.status,
          });
        }
      }
    }
  }

  const challenges = (rewards ?? []).map((r) => {
    const rule = (r.unlock_rule ?? {}) as Record<string, unknown>;
    const type = String(rule.type ?? "");
    const window = String(rule.window ?? "once");
    let target: number | null = null;
    let progress: number | null = null;
    let unit = "";
    if (type === "gift_subs") {
      target = Number(rule.count) || 0; unit = "gift subs";
      progress = viewer ? (window === "month" ? sums.gifts_month : sums.gifts_all) : null;
    } else if (type === "bits") {
      target = Number(rule.count) || 0; unit = "bits";
      progress = viewer ? (window === "month" ? sums.bits_month : sums.bits_all) : null;
    } else if (type === "sub_months") {
      target = Number(rule.months) || 0; unit = "months subscribed";
      progress = viewer ? sums.sub_months : null;
    } else if (type === "watch_hours") {
      target = (Number(rule.hours) || 0) * 60; unit = "minutes watched";
      progress = viewer ? (supporter?.watch_minutes ?? 0) : null;
    } else if (type === "supporter_value" || type === "fan_value") {
      target = Number(rule.cents) || 0; unit = "support cents";
      progress = viewer ? (supporter?.supporter_value_cents ?? 0) : null;
    } else if (type === "channel_points") {
      target = null; unit = "channel points";
    }
    const claim = claimByReward.get(r.id) ?? null;
    return {
      id: r.id, name: r.name, tier: r.tier, item_type: r.item_type,
      type, window, unit, target, progress,
      unlocked: !!claim || (target !== null && progress !== null && progress >= target && target > 0),
      claim,
    };
  });

  return json({
    streamer: { name: streamer.display_name, avatar: streamer.avatar_url, live: streamer.is_live },
    me: viewer ? { name: viewer.name } : null,
    challenges,
  });
});
