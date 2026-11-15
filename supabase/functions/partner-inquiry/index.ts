// Receives brand/sponsor inquiries from partners.html and stores them in
// partner_inquiries. Public endpoint with validation and a honeypot field.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  // Honeypot: real visitors never see this field; bots fill it.
  if (clean(body.website, 10)) return json({ ok: true });

  const name = clean(body.name, 80);
  const email = clean(body.email, 160);
  const message = clean(body.message, 2000);
  if (!name || !message) return json({ error: "Name and a short message are required" }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "That email doesn't look right" }, 400);

  const { error } = await db.from("partner_inquiries").insert({
    name,
    email,
    message,
    company: clean(body.company, 120) || null,
    interest: clean(body.interest, 60) || null,
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null,
  });
  if (error) {
    console.error("partner inquiry insert failed", error);
    return json({ error: "Couldn't save your inquiry" }, 500);
  }
  return json({ ok: true });
});
