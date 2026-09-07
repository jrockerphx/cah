# cah-webapp API

A small Express service that reads and writes the exact same Postgres
tables the Rust bot (`cah_bot`) already uses. It's what gives the Telegram
Mini App frontend (`public/index.html`) something to talk to, instead of
Telegram's inline-query hand-picking flow.

For what this project is, how to deploy it, and full environment variable
docs, see the [top-level README](../README.md) — this file just covers the
API itself.

## What this does NOT change

- The Rust bot keeps running exactly as deployed. `/start`, `/settings`,
  `/status`, `/rank`, `/close`, `/help` all keep working untouched.
- The Postgres schema is untouched — same `chats`, `players`, `cards`,
  `hands`, `packs`, `chat_packs` tables from `../schema.postgres.sql`.

## Before pointing real users at this

Playing a card can happen through the bot's inline-query code
(`src/bot/parser/play.rs`, `choose.rs`) OR through this API. If both are
live and both writing to the `hands` table for the same game at once, they
can race each other or double-deal cards.

**Pick one path.** Either the group plays via the "Open cards hand" inline
button (bot-only, original behavior), or they play via the Mini App (this
API). The intended setup — what the top-level README's deploy
instructions produce — is setting `WEBAPP_URL` on the bot, which switches
its button over to a `web_app` button pointing at this service, so the
Mini App becomes the only place cards get played. Leave `WEBAPP_URL`
unset and the bot ignores this API entirely, falling back to its original
inline-query flow.

The two things this file used to flag as prototype-only rough edges have
since been fixed in this codebase:

- Rando Carlissian's dealing was rewritten (see the comment above
  `dealNewTurn()` below) to stop over-dealing and burning through the card
  pack — it now deals exactly `pick` cards per round, same as everyone
  else.
- `submissionToken` in the judge's view of `GET /api/state` is an opaque
  per-turn shuffle index, not a player id — the judge's browser never
  receives real player identities before choosing. `POST /api/choose`
  re-runs the same shuffle server-side to resolve identity only after the
  pick is made.

What's still on you: **`REQUIRE_TELEGRAM_AUTH` defaults to `false`**, so
you can poke at this locally with `curl` or a browser using
`?user=<telegram_id>`. Set it to `true` (see `.env.example`) before this
is reachable from the internet — and confirm the frontend is actually
sending `X-Telegram-Init-Data` when you do.

## Endpoints

- `GET /api/state?chat=<telegram_chat_id>` — current turn, black card, and
  either "your hand" (regular player) or "submissions to judge" (judge),
  matching the reveal-only-when-everyone's-played rule from `play.rs`.
  Also returns `previousWinner` (the last round's winning card/name), used
  to broadcast the crowning celebration to every client, not just the
  judge who clicked it.
- `POST /api/play` `{ chat, handId }` — submit one white card.
- `POST /api/choose` `{ chat, submissionToken }` — judge picks a winner;
  awards the point, deals the next black card, tops every hand back up,
  and posts a summary back into the Telegram group.

## Local dev

```bash
cp .env.example .env    # fill in BOT_TOKEN if you want Telegram notifies
npm install
npm start
```

Requires Node 18+ (uses the built-in `fetch`). With
`REQUIRE_TELEGRAM_AUTH=false`, open `public/index.html` directly and drive
it with `?chat=<id>&user=<telegram_id>` instead of real Telegram auth.
