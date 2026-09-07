-- Postgres schema for cah_bot + the Mini App webapp.
--
-- Both services read/write these six tables. `packs`/`cards` are seeded
-- automatically by the bot on its first boot (from the bundled
-- cah-cards-full.json — see the Credits section in README.md) as long as
-- `packs` is empty, so you do NOT need to load any card data by hand.
-- Just run this file once against a fresh database and start the stack.

CREATE TABLE IF NOT EXISTS chats (
    id               SERIAL PRIMARY KEY,
    telegram_id      BIGINT NOT NULL,
    owner            INTEGER,
    start_date       TIMESTAMP NOT NULL,
    end_date         TIMESTAMP,
    players          INTEGER NOT NULL DEFAULT 0,
    turn             INTEGER NOT NULL DEFAULT 1,
    rando_carlissian BOOLEAN NOT NULL DEFAULT false,
    pick             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS players (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    chat_id     INTEGER NOT NULL REFERENCES chats (id),
    name        VARCHAR(255) NOT NULL,
    turn        INTEGER NOT NULL,
    points      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (id, chat_id)
);

CREATE TABLE IF NOT EXISTS packs (
    id       SERIAL PRIMARY KEY,
    name     VARCHAR(255) NOT NULL,
    official BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS cards (
    id      SERIAL PRIMARY KEY,
    pack_id INTEGER NOT NULL REFERENCES packs (id),
    color   VARCHAR(5) NOT NULL,
    pick    INTEGER,
    -- TEXT, not VARCHAR(255): the bundled cah-cards-full.json has at least
    -- one card (a "Reject Pack 3" black card) that's 908 characters long.
    -- VARCHAR(255) here made every fresh deploy crash-loop forever on
    -- first boot -- pack::init() seeds all cards in one transaction, so
    -- the oversized INSERT failing rolled back the whole batch, leaving
    -- `packs` empty, which made the bot retry the exact same doomed seed
    -- on every restart. TEXT has no length cap and no storage/performance
    -- cost difference from VARCHAR(n) in Postgres -- there's no reason to
    -- guess at a number here.
    text    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hands (
    id             SERIAL PRIMARY KEY,
    player_id      INTEGER NOT NULL,
    chat_id        INTEGER NOT NULL REFERENCES chats (id),
    card_id        INTEGER NOT NULL REFERENCES cards (id),
    picked_on_turn INTEGER NOT NULL,
    played_on_turn INTEGER,
    seq            INTEGER NOT NULL DEFAULT 0,
    won            BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS chat_packs (
    chat_id INTEGER NOT NULL REFERENCES chats (id),
    pack_id INTEGER NOT NULL REFERENCES packs (id),
    PRIMARY KEY (chat_id, pack_id)
);

-- A couple of indexes the hot paths (dealing, judging, polling) benefit
-- from. Not required for correctness, just for not making Postgres think
-- about it on every poll.
CREATE INDEX IF NOT EXISTS idx_hands_chat_player ON hands (chat_id, player_id);
CREATE INDEX IF NOT EXISTS idx_hands_chat_turn ON hands (chat_id, played_on_turn);
CREATE INDEX IF NOT EXISTS idx_cards_pack ON cards (pack_id);
CREATE INDEX IF NOT EXISTS idx_players_chat ON players (chat_id);
