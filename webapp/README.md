# cah-webapp API (prototype)

A small Express service that reads and writes the exact same Postgres
tables `cah_bot` (the Rust bot) already uses. It exists to give a real
HTML5 UI (a Telegram Mini App) something to talk to instead of Telegram's
inline-query hand-picking flow.

## What this does NOT change

- The Rust bot keeps running exactly as deployed. `/start`, `/settings`,
  `/status`, `/rank`, `/close`, `/help` all keep working untouched.
- The Postgres schema is untouched — same `chats`, `players`, `cards`,
  `hands`, `packs`, `chat_packs` tables from `schema.postgres.sql`.

## What this DOES change (read before wiring it up for real)

Right now, playing a card happens through the bot's inline-query code
(`src/bot/parser/play.rs`, `choose.rs`). If this API and the bot are BOTH
live and BOTH writing to the `hands` table at the same time, they can race
each other or double-deal cards. Before pointing real users at this:

1. **Pick one path.** Either the group keeps playing via the "Open cards
   hand" inline button (bot-only, current behavior), or they play via the
   Mini App (this API). Don't run both against the same live game — the
   cleanest option is dropping the `web_app` button in place of the inline
   button once this is working, so the Mini App is the only place cards get
   played.
2. **Rando Carlissian dealing was intentionally rewritten, not ported
   byte-for-byte.** See the big comment above `dealNewTurn()` in
   `server.js` — upstream's loop looked like it over-deals Rando's hand each
   turn. This version tops Rando up once and marks exactly `pick` cards
   played. Worth a second look if you care about exact parity with
   upstream's balance/behavior.
3. **`submissionToken` in `GET /api/state`'s judge view is literally the
   player's internal id right now.** That's fine for a local prototype,
   but it means the judge's browser can see whose card is whose before
   picking, which defeats the anonymity that's the entire point of the
   game. Before shipping: replace with an opaque per-turn token and resolve
   identity server-side inside `POST /api/choose`.
4. **No Telegram auth is enforced by default** (`REQUIRE_TELEGRAM_AUTH=false`).
   That's so you can poke at it locally with `curl` or a browser using
   `?user=<telegram_id>`. Flip it on, and make sure the frontend actually
   sends `X-Telegram-Init-Data` (see the frontend prototype's comments),
   before this is reachable from the internet.

## Endpoints

- `GET /api/state?chat=<telegram_chat_id>` — current turn, black card, and
  either "your hand" (regular player) or "submissions to judge" (judge),
  matching the reveal-only-when-everyone's-played rule from `play.rs`.
- `POST /api/play` `{ chat, handId }` — submit one white card.
- `POST /api/choose` `{ chat, submissionToken }` — judge picks a winner;
  awards the point, deals the next black card, tops every hand back up to
  10, and posts a summary back into the Telegram group.

## Running it next to the existing stack

Add as a new service in the same `docker-compose.yml` cah_bot already
uses, on the same network as `postgres`:

```yaml
  cah_web:
    build: ./cah-webapp/api
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres/cah_bot
      BOT_TOKEN: ${BOT_TOKEN}
      REQUIRE_TELEGRAM_AUTH: "true"
    depends_on:
      postgres:
        condition: service_healthy
```

Then give it a Coolify domain with a real TLS cert (Telegram requires
`https://` for Mini App URLs — this is the first service in the stack
that needs one). Point the static frontend's `API_BASE` at that domain,
and change the bot's "Open cards hand" button from
`for_switch_inline_query_current_chat` to a `web_app` button pointing at
the frontend's URL (that part requires a small patch to the Rust source —
forking `nappa85/cah_bot` rather than building from upstream directly, the
way the compose file currently does).

## Local dev

```bash
cp .env.example .env    # fill in BOT_TOKEN if you want Telegram notifies
npm install
npm start
```

Requires Node 18+ (uses the built-in `fetch`).
