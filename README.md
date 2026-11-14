# Clicktide Creators

Automatically mails real postcards and gifts to a Twitch streamer's top supporters
when they hit milestones (gift subs, sub anniversaries). Gifts arrive "from the
streamer." Streamers never see supporter addresses.

**Completely separate from the original Clicktide** (goclicktide.com). This product has:

- Its own GitHub repo: `clicktide-creators` (this one)
- Its own website: GitHub Pages (`https://tmclaurin34.github.io/clicktide-creators/`)
- Its own Supabase project: **Clicktide Creators** (`cjzafsnsumlpifewbqaq`, US East)

## What's in this repo

| File | What it is |
|---|---|
| `index.html` | Streamer dashboard — "Connect Twitch" login, budget, reward rules, claims list |
| `claim.html` | Supporter claim page — where a fan enters their address (streamer never sees it) |
| `styles.css`, `config.js` | Styling and public settings. `config.js` holds only the *publishable* Supabase key — safe to be public. Row-level security protects the data. |
| `supabase/functions/twitch-connect` | Saves the streamer's channel + subscribes it to Twitch events |
| `supabase/functions/twitch-eventsub` | Receives Twitch webhooks (verifies Twitch's signature), tracks supporters, unlocks gifts |
| `supabase/functions/claim` | Claim API — verifies the fan's Twitch login, saves the address, mails the card through Lob |

All three functions are **already deployed** to the Supabase project. The copies here
are the source of truth going forward — edit here, then redeploy.

## Secrets (never in this repo, never in chat)

All secret keys live in **Supabase → project "Clicktide Creators" → Edge Functions → Secrets**:

| Name | What it is |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | From dev.twitch.tv → your "Clicktide Creators" app |
| `TWITCH_EVENTSUB_SECRET` | A random string you made up (verifies Twitch's webhook signatures) |
| `LOB_API_KEY` | Lob dashboard → API Keys (`test_…` key until launch) |
| `LOB_FROM_ADDRESS_ID` | Lob dashboard → Addresses → your return address (`adr_…`) |

The Twitch login (Client ID + Secret) is also pasted into
**Supabase → Authentication → Sign In / Providers → Twitch**.

## Security model

- RLS is on for every table. Streamers can read their own rows, rewards and claims —
  but there is **no policy** that lets any logged-in user read `claim_addresses` or
  `supporter_addresses`. Addresses are only touched by server functions using the
  service key, after verifying the supporter's own Twitch login.
- Twitch webhook signatures are verified (HMAC) with a timestamp freshness check.
- No secrets in this repo; `config.js` contains only the publishable key.

## Build phases

- [x] Phase 1 — Streamer signup (Twitch OAuth, streamer profile) — **live, verified Nov 13 2026**
- [x] Phase 2 — Milestone rules dashboard (partially: rules + presets done; card photo/logo/message upload UI not built yet)
- [x] Phase 3 — Milestone detection (EventSub webhooks + unlock engine) — deployed
- [x] Phase 4 — Claim flow (private link, address form, RLS-protected)
- [x] Phase 5 — Lob postcard sending (test mode until a live Lob key is set)
- [ ] Phase 6 — OBS overlay + test alert button (not started)
