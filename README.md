# We Should Be Ashamed...

A Cards Against Humanity bot for Telegram groups, with a real touch-friendly
Mini App so your group plays on an actual card table instead of squinting
at Telegram's inline-query popup.

This project stands on two other people's work: the bot itself is a fork
of [**nappa85/cah_bot**](https://github.com/nappa85/cah_bot), and every
card in the deck comes from [**JSON Against
Humanity**](https://www.crhallberg.com/cah/). See **[Credits](#credits)**
below — nothing here would exist without them.

<p align="center">
  <img src="docs/screenshots/player-hand.png" width="260" alt="Your hand of white cards, laid out in an overlapping grid" />
  <img src="docs/screenshots/judge-view.png" width="260" alt="Judge view with submissions face-down, one flipped to read" />
  <img src="docs/screenshots/winner-overlay.png" width="260" alt="Full-screen winner celebration with crown animation" />
</p>

## What this actually is

`nappa85/cah_bot` plays Cards Against Humanity entirely through Telegram's
inline-query mechanism — you tap a button, Telegram pops up a search-style
list of your hand, you tap a card. It works, but it's cramped, it's not
built for reading a full hand of cards at once, and it doesn't feel like a
card game.

This fork keeps the bot exactly as it was for everything else (`/start`,
`/settings`, `/status`, `/rank`, `/close`, `/help` are untouched) and adds
one thing: an optional **Telegram Mini App** — a real webapp that opens
inside Telegram, reads and writes the same Postgres tables the bot already
uses, and gives you an actual table of cards with animations, instead of a
dropdown.

## Features

- **A hand that looks like a hand.** Your (up to 10) cards are laid out in
  a four-wide grid with each row overlapping the one above it by about a
  third, so the whole hand is readable at a glance on a phone screen with
  no side-scrolling — no more hunting through a horizontal list to find
  the card you wanted.
- **Judge view with a real flip.** Submissions come in face-down; tap one
  to flip it over and read it, tap "crown winner" when you've decided.
  Nobody's identity is visible to the judge — see [How anonymity
  works](#how-anonymity-works).
- **A crowning worth watching.** Winning triggers a full-screen animation
  — the winning card, the winner's name, and a randomly generated,
  entirely unnecessary insult about what kind of person picks that card —
  and it broadcasts to *everyone's* screen, not just the judge's, so the
  whole group sees the moment together.
- **Rando Carlissian, fixed.** The upstream bot's logic for dealing cards
  to the bot-controlled "Rando Carlissian" player over-deals and burns
  through the card pack roughly 10x too fast (see
  [`webapp/server.js`](webapp/server.js)'s `dealNewTurn()` for the full
  story). This fork's dealing logic was rewritten to deal exactly the
  right number of cards, every round.
- **Runs alongside the bot, not instead of it.** The Mini App reads and
  writes the exact same `chats` / `players` / `hands` / `cards` tables —
  it's a second front door to the same game, not a fork of the game logic.

## How it's built

Two services, one database:

```
┌─────────────────┐        ┌──────────────────────┐
│   cah_bot        │        │   cah_web             │
│   (Rust/Telegram)│        │   (Node/Express + JS) │
│                   │        │                        │
│   handles /start, │        │   serves the Mini App  │
│   /settings, group │───┐  │───┐   frontend + a small │
│   commands, and    │   │  │   │   JSON API           │
│   the inline-query  │   │  │   │                       │
│   fallback flow      │   ▼  ▼                          │
└──────────────────────►  Postgres  ◄─────────────────────┘
                        (chats, players, cards,
                         hands, packs, chat_packs)
```

- **`src/`** — the Rust bot (`tgbot` + `sea-orm`), forked from
  `nappa85/cah_bot`. `src/entities/` is the source of truth for the
  database schema.
- **`webapp/server.js`** — a small Express API that speaks the same
  schema: `GET /api/state`, `POST /api/play`, `POST /api/choose`.
- **`webapp/public/index.html`** — the Mini App frontend itself. Single
  file, no build step, no framework — vanilla JS/CSS, on purpose, so
  there's nothing to compile before you can read it.

Card packs aren't loaded by hand — `cah-cards-full.json` (from JSON
Against Humanity, see [Credits](#credits)) is bundled into the bot binary
at compile time and inserted into the `packs`/`cards` tables automatically
the first time the bot starts against an empty database.

### How anonymity works

The judge's browser never receives player identities. `GET /api/state`
hands the judge a per-turn shuffled index (`submissionToken`) instead of a
player id; `POST /api/choose` re-runs that same shuffle server-side and
resolves the index back to a real player only after the judge has already
picked. The judge's client literally cannot know who played what before
choosing.

## Deploying it

You need: a Telegram bot token, a Postgres database, and somewhere to run
two small containers with an HTTPS domain (Telegram requires `https://`
for Mini App URLs — plain `http://` will not work).

### 1. Create the bot with BotFather

1. Talk to [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
   prompts. Save the token it gives you — that's your `BOT_TOKEN`.
2. Send `/setinline` and enable inline mode for your bot (needed even with
   the Mini App, as the fallback path).
3. Send `/setinlinefeedback` and set it to **100%** — the bot needs this
   to know which card was actually chosen.
4. Note your bot's username without the `@` — that's your `BOT_NAME`.

### 2. Get an HTTPS domain for the Mini App

The webapp needs to be reachable over HTTPS. If you're running this on
[Coolify](https://coolify.io), point a domain at the `cah_web` service and
let Coolify issue the certificate — that's the easiest path and what this
project was actually deployed on. Any reverse proxy with a real cert works
the same way.

### 3. Run it

```bash
git clone <your fork's URL>
cd <cloned directory>
cp .env.example .env   # fill in BOT_TOKEN, BOT_NAME, and WEBAPP_URL (your https:// domain)
docker compose up -d --build
```

`docker-compose.yml` and `schema.postgres.sql` at the repo root are set up
to run standalone — Postgres, the bot, and the webapp, wired together,
with the schema applied automatically the first time the database volume
is created.

> **One thing not to change:** the bot's database connection string is
> hardcoded in `src/main.rs` as
> `postgres://postgres:postgres@postgres/cah_bot` — it isn't read from an
> environment variable. That means the Postgres service in
> `docker-compose.yml` has to keep the hostname `postgres` and those exact
> credentials, or the bot won't find its database. If you need different
> credentials, patch `src/main.rs` and rebuild — don't just edit the
> compose file.

Leave `WEBAPP_URL` unset and the bot works exactly like stock
`nappa85/cah_bot` — the "Open cards hand" button falls back to the
original inline-query flow, no Mini App involved. Set it once your HTTPS
domain is live and the button switches over automatically.

### Environment variables

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `BOT_TOKEN` | both | yes | From BotFather. |
| `BOT_NAME` | bot | yes | Bot username, with or without the leading `@`. |
| `WEBAPP_URL` | bot | no | `https://` URL of the deployed Mini App. Unset = inline-query fallback only. |
| `DATABASE_URL` | webapp | yes | Defaults to `postgres://postgres:postgres@postgres/cah_bot` in `.env.example` — matches the bot's hardcoded connection, don't change one without the other. |
| `PORT` | webapp | no | Defaults to `3001`. |
| `REQUIRE_TELEGRAM_AUTH` | webapp | **yes, before going public** | Defaults to `false` for local testing. Set `true` before exposing this to the internet — see the warning in `webapp/.env.example`. |

### Local development

Bot:

```bash
cargo run
```

Webapp:

```bash
cd webapp
cp .env.example .env
npm install
npm start   # requires Node 18+ (uses the built-in fetch)
```

With `REQUIRE_TELEGRAM_AUTH=false` you can open `webapp/public/index.html`
directly and drive it with `?chat=<id>&user=<telegram_id>` query params
instead of real Telegram auth — that's how the screenshots above were
made.

## Project layout

```
src/                    Rust bot (fork of nappa85/cah_bot)
  entities/              sea-orm models — source of truth for the schema
  bot/                    Telegram command + inline-query handlers
webapp/
  server.js               Express API (/api/state, /api/play, /api/choose)
  public/index.html        Mini App frontend (vanilla JS/CSS, no build step)
docker/Dockerfile        Bot image
webapp/Dockerfile        Webapp image
docker-compose.yml       Runs both + Postgres together
schema.postgres.sql      Postgres schema, applied automatically on first boot
cah-cards-full.json      Card data (JSON Against Humanity, see Credits)
```

## Credits

This project didn't invent Cards Against Humanity, the Telegram bot that
plays it, or the card text itself. It's a continuation of other people's
work, and it wouldn't exist without them:

- **[nappa85/cah_bot](https://github.com/nappa85/cah_bot)** — the
  original Rust/Telegram bot this repo is forked from. All of the core
  game logic (turn order, dealing, scoring, the inline-query play flow)
  is theirs. This fork's contribution is the Mini App front door bolted
  on next to it, plus the Rando Carlissian dealing fix described above.
- **[JSON Against Humanity](https://www.crhallberg.com/cah/)** — the
  source of every card in `cah-cards-full.json`. All the actual jokes you
  see when you play are from their compiled card set, not written for
  this project.
- **Cards Against Humanity** itself — the original party game this is all
  in service of, released under a Creative Commons BY-NC-SA license by
  Cards Against Humanity LLC.

If you use this, please keep this section intact and pass the credit
along.

## License

**Card content** (`cah-cards-full.json`) is Cards Against Humanity's own
text, which CAH releases under **Creative Commons BY-NC-SA 2.0**
([full terms](https://creativecommons.org/licenses/by-nc-sa/2.0/), stated
directly in [their own game PDF](https://s3.amazonaws.com/cah/CAH_MainGame.pdf)).
In plain terms, three conditions, not just "free and not for profit":

1. **Attribution** — credit Cards Against Humanity (done, see Credits above).
2. **NonCommercial** — this project, and anything built from it, can't be
   sold or monetized.
3. **ShareAlike** — if you redistribute this card data, modified or not,
   it has to carry this same BY-NC-SA license. You can't fork the cards
   and relicense them more restrictively.

(JSON Against Humanity's own repo labels itself BY-NC-SA *4.0* — that's
their choice for their own compiled JSON/code, not CAH's official version.
CAH's own PDF states 2.0, which is what actually governs the card text
itself.)

**Bot code**: neither this fork nor
[nappa85/cah_bot](https://github.com/nappa85/cah_bot) carries an explicit
license file at time of writing, which defaults to "all rights reserved"
under copyright law regardless of how open forking on GitHub feels. Not
an issue for running this yourself; check with the upstream author before
reusing the Rust code commercially or redistributing it under your own
license. (None of this is legal advice — if it actually matters for your
situation, e.g. you want to monetize something built on this, talk to an
actual lawyer.)
