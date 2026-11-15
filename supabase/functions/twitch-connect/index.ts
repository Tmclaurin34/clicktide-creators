// Called by the streamer dashboard after "Log in with Twitch".
// Creates (or finds) the streamer row, stores their Twitch refresh token (for the
// watch-time tracker), and subscribes the channel to Twitch EventSub.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") ?? "";
const EVENTSUB_SECRET = Deno.env.get("TWITCH_EVENTSUB_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EVENT_TYPES = [
  "channel.subscribe",
  "channel.subscription.message",
  "channel.subscription.gift",
  "channel.cheer",
  "channel.channel_points_custom_reward_redemption.add",
  "stream.online",
  "stream.offline",
];

async function appToken(): Promise<string> {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Twitch token request failed (${res.status})`);
  const data = await res.json();
  return data.access_token as string;
}

async function subscribeAll(broadcasterId: string) {
  const token = await appToken();
  const callback = `${SUPABASE_URL}/functions/v1/twitch-eventsub`;
  const results: Record<string, string> = {};
  for (const type of EVENT_TYPES) {
    const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type,
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        transport: { method: "webhook", callback, secret: EVENTSUB_SECRET },
      }),
    });
    if (res.status === 202) results[type] = "subscribed";
    else if (res.status === 409) results[type] = "already subscribed";
    else {
      const text = await res.text();
      console.error(`EventSub ${type} failed`, res.status, text);
      results[type] = `failed (${res.status})`;
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "Not logged in" }, 401);
  const user = userData.user;

  const identity = user.identities?.find((i) => i.provider === "twitch");
  if (!identity) return json({ error: "Log in with Twitch first" }, 400);
  const idData = (identity.identity_data ?? {}) as Record<string, unknown>;
  const twitchId = String(idData.provider_id ?? idData.sub ?? identity.id);
  const displayName = String(
    idData.nickname ?? idData.name ?? idData.user_name ?? idData.preferred_username ?? "Streamer",
  );

  // Twitch profile picture (only keep Twitch's own image host).
  const rawAvatar = String(idData.avatar_url ?? idData.picture ?? "");
  const avatarUrl = rawAvatar.startsWith("https://static-cdn.jtvnw.net/") ? rawAvatar : null;

  // The dashboard forwards the Twitch refresh token from the login session so the
  // watch-time tracker can act for this channel later.
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* no body */ }
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token.length > 20
    ? body.refresh_token : null;

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: existing, error: findErr } = await db
    .from("streamers")
    .select("*")
    .eq("platform", "twitch")
    .eq("platform_user_id", twitchId)
    .maybeSingle();
  if (findErr) return json({ error: "Lookup failed" }, 500);

  let streamer = existing;
  if (existing && existing.owner_user_id !== user.id) {
    return json({ error: "This channel is already connected to another account" }, 409);
  }
  if (!existing) {
    const { data: created, error: insertErr } = await db
      .from("streamers")
      .insert({ owner_user_id: user.id, platform: "twitch", platform_user_id: twitchId, display_name: displayName, avatar_url: avatarUrl })
      .select("*")
      .single();
    if (insertErr) return json({ error: "Could not create streamer" }, 500);
    streamer = created;
  } else if (avatarUrl && existing.avatar_url !== avatarUrl) {
    await db.from("streamers").update({ avatar_url: avatarUrl }).eq("id", existing.id);
    streamer = { ...existing, avatar_url: avatarUrl };
  }

  let watchTracking = false;
  if (refreshToken && streamer) {
    const { error: tokErr } = await db.from("streamer_tokens").upsert(
      { streamer_id: streamer.id, refresh_token: refreshToken, updated_at: new Date().toISOString() },
      { onConflict: "streamer_id" },
    );
    if (tokErr) console.error("Saving refresh token failed", tokErr);
    else watchTracking = true;
  } else if (streamer) {
    const { data: tok } = await db.from("streamer_tokens").select("streamer_id").eq("streamer_id", streamer.id).maybeSingle();
    watchTracking = !!tok;
  }

  let subscriptions: Record<string, string> | string = "Twitch keys not set yet";
  if (CLIENT_ID && CLIENT_SECRET && EVENTSUB_SECRET) {
    try {
      subscriptions = await subscribeAll(twitchId);
    } catch (err) {
      console.error(err);
      subscriptions = "Could not reach Twitch";
    }
  }

  return json({ streamer, subscriptions, watch_tracking: watchTracking });
});
