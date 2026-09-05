-- Postgres-corrected version of nappa85/cah_bot's schema.sql
-- The upstream file is written in MySQL dialect (AUTO_INCREMENT, DATETIME) but the
-- bot connects with sea-orm's sqlx-postgres driver, so the original file will fail
-- with a syntax error if you run it against Postgres as-is. This is the same schema
-- translated to valid Postgres DDL.

CREATE TABLE chats (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    owner INTEGER,
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP DEFAULT NULL,
    players INTEGER NOT NULL DEFAULT 0,
    turn INTEGER NOT NULL DEFAULT 1,
    rando_carlissian BOOLEAN NOT NULL DEFAULT false,
    pick INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE players (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    chat_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    turn INTEGER NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    UNIQUE (id, chat_id)
);

CREATE TABLE packs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    official BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE cards (
    id SERIAL PRIMARY KEY,
    pack_id INTEGER NOT NULL,
    color CHAR(5) NOT NULL,
    pick INTEGER DEFAULT NULL,
    text VARCHAR(255) NOT NULL
);

CREATE TABLE hands (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    picked_on_turn INTEGER NOT NULL,
    played_on_turn INTEGER DEFAULT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    won BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE chat_packs (
    chat_id INTEGER,
    pack_id INTEGER,
    PRIMARY KEY (chat_id, pack_id)
);
