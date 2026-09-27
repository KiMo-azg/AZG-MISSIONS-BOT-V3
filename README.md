# AZG Missions

Simple Discord + CS 1.6 Missions backend.

## What it does

- `/link` sends a temporary linking code by Discord DM.
- `/unlink` disconnects your Discord account from your SteamID.
- `/mystatus` shows your linked SteamID and current mission progress (only visible to you).
- CS 1.6 plugin verifies the code with the API.
- Daily and weekly missions are stored in Postgres.
- Mission progress is stored per player, and resets automatically each time a new
  daily/weekly rotation starts.
- When a mission reaches its target, the player receives a DM.
- The bot does NOT give XP, Coins, Discord Roles, or automatic prizes.
- The Owner/Admin handles the reward manually after checking the player's screenshot.

## Setup

1. Install Node.js 18+.
2. Create a free Postgres database at [neon.tech](https://neon.tech) and copy its
   connection string.
3. Run:
   `npm install`
4. Copy `.env.example` to `.env`.
5. Put the Discord bot token in `.env`.
6. Put the Neon connection string in `.env` as `DATABASE_URL`.
7. Generate a strong random `AZG_API_KEY`.
8. Put the missions channel ID in `.env`.
9. Run:
   `npm start`

The database tables are created automatically on first run — no manual migration
needed.

## API authentication

Every CS Plugin API request must include:

`x-azg-api-key: YOUR_AZG_API_KEY`

## API endpoints

### GET /health
No key required. Also used internally by the keep-alive heartbeat (see below).

### GET /api/missions
Returns currently active daily and weekly missions.

### POST /api/verify-link
Body:
{
  "code": "AZG-XXXXXXXX",
  "steamid": "STEAM_0:1:123456"
}

### POST /api/mission-progress
Body:
{
  "steamid": "STEAM_0:1:123456",
  "missionId": "d1",
  "amount": 1
}

The CS plugin is responsible for checking the detailed game condition (weapon, map, team, headshot, etc.). It should only send progress when the event actually qualifies.

### GET /api/player-progress/:steamid
Returns stored progress for the linked player.

## Important

Keep `.env` private. Never paste the Discord token, API key, or database
connection string into public code or GitHub.

## Hosting notes (Render)

**Data is safe regardless of Render restarts.** The database now lives on Neon
(a separate, always-on Postgres host), not on Render's local disk. Redeploys,
restarts, or the free service spinning down no longer wipe any data — Neon's
storage is durable and independent of what happens to the Render container.

**The free web service still sleeps by default.** A free Render service spins
down after 15 minutes without an incoming HTTP request. To prevent that, the
bot pings its own `/health` endpoint every 10 minutes (see the "Keep-alive
heartbeat" section in `index.js`). Render sets `RENDER_EXTERNAL_URL`
automatically, so this needs no extra configuration once deployed.

**Important: this heartbeat does not reduce usage of Render's free hours.**
Render's free plan grants 750 free instance-hours per workspace per month. A
service that's kept awake around the clock uses close to that entire monthly
allowance either way — whether it stays awake because of real traffic or
because of this self-ping. The heartbeat's job is only to stop the bot from
going quiet and disconnecting from Discord (and to avoid the ~30-60s delay on
the first request after a nap); it doesn't get you extra free hours. If this
Render account only runs this one service, ~730 hours in a 30-day month
still fits under the 750-hour cap, but there's very little margin left for
anything else on the same account.
