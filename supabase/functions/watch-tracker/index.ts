// Watch-time tracker: runs every 5 minutes (pg_cron). For each live channel it
// refreshes the streamer's Twitch token, asks Twitch who is in chat, and credits
// each viewer +5 minutes via record_watch_minutes (which also unlocks rewards).
// Safe against double-runs: a per-streamer 4-minute gate plus per-viewer
// deduplicated event ids per 5-minute bucket.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") ?? "";

const MINUTES_PER_POLL = 5;

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: res.status, data };
  return { access_token: data.access_token as string, refresh_token: data.refresh_token as string | undefined };
}

async function chatters(broadcasterId: string, accessToken: string) {
  const users: { user_id: string; user_name: string }[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.twitch.tv/helix/chat/chatters");
    url.searchParams.set("broadcaster_id", broadcasterId);
    url.searchParams.set("moderator_id", broadcasterId);
    url.searchParams.set("first", "1000");
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`chatters ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const u of data.data ?? []) users.push({ user_id: String(u.user_id), user_name: String(u.user_name ?? u.user_login ?? "") });
    cursor = data.pagination?.cursor ?? "";
    if (!cursor) break;
  }
  return users;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const cutoff = new Date(Date.now() - 4 * 60_000).toISOString();
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const summary: Record<string, unknown> = {};

  const { data: live, error } = await db
    .from("streamers")
    .select("id, platform_user_id, display_name, last_polled_at, streamer_tokens(refresh_token)")
    .eq("is_live", true)
    .eq("platform", "twitch");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  for (const s of live ?? []) {
    const tok = (s as any).streamer_tokens;
    const refreshToken: string | undefined = Array.isArray(tok) ? tok[0]?.refresh_token : tok?.refresh_token;
    if (!refreshToken) { summary[s.display_name] = "no token (streamer must log in again)"; continue; }

    // 4-minute gate so repeated invocations can never double-credit.
    const { data: gate } = await db
      .from("streamers")
      .update({ last_polled_at: new Date().toISOString() })
      .eq("id", s.id)
      .eq("is_live", true)
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
      .select("id");
    if (!gate || gate.length === 0) { summary[s.display_name] = "recently polled, skipped"; continue; }

    try {
      const t = await refreshAccessToken(refreshToken);
      if ("error" in t) {
        summary[s.display_name] = `token refresh failed (${t.error})`;
        if (t.error === 400 || t.error === 401) {
          await db.from("streamer_tokens").delete().eq("streamer_id", s.id); // must re-login
        }
        continue;
      }
      if (t.refresh_token && t.refresh_token !== refreshToken) {
        await db.from("streamer_tokens").update({ refresh_token: t.refresh_token, updated_at: new Date().toISOString() }).eq("streamer_id", s.id);
      }

      const users = await chatters(s.platform_user_id, t.access_token!);
      let credited = 0, unlocked = 0;
      for (const u of users) {
        if (!u.user_id) continue;
        const { data: claims, error: rpcErr } = await db.rpc("record_watch_minutes", {
          p_streamer_id: s.id,
          p_platform: "twitch",
          p_platform_user_id: u.user_id,
          p_display_name: u.user_name || null,
          p_minutes: MINUTES_PER_POLL,
          p_platform_event_id: `wt-${bucket}-${u.user_id}`,
        });
        if (rpcErr) { console.error("record_watch_minutes", rpcErr); continue; }
        credited++;
        if (Array.isArray(claims)) unlocked += claims.length;
      }
      summary[s.display_name] = { chatters: users.length, credited, unlocked };
      if (unlocked > 0) console.log(`${s.display_name}: ${unlocked} reward(s) unlocked by watch time`);
    } catch (err) {
      console.error(`poll failed for ${s.display_name}`, err);
      summary[s.display_name] = "poll failed";
    }
  }

  return new Response(JSON.stringify({ polled: Object.keys(summary).length, summary }), {
    headers: { "Content-Type": "application/json" },
  });
});
