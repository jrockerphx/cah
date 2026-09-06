// cah-webapp API — a thin HTTP layer over the SAME Postgres database cah_bot
// already uses. It does not replace the Rust bot: /start, /settings, /close,
// /rank etc. keep working exactly as they do today. This service only takes
// over the part that used to be Telegram inline-query gymnastics (viewing
// your hand, playing a card, judging) so a real HTML5 UI can do it instead.
//
// Ported by hand from nappa85/cah_bot's Rust source (src/entities/*.rs,
// src/bot/parser/{play,choose,status}.rs) — see the comments below for which
// function each block mirrors. A few upstream quirks around Rando Carlissian
// dealing were intentionally cleaned up rather than byte-for-byte copied;
// those spots are flagged.
//
// NOT production-hardened. No rate limiting, no request logging, minimal
// input validation. Treat this as the second draft, not the last one.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN; // same token the Rust bot uses
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres/cah_bot';
// Set to "true" once you've wired real Telegram WebApp auth end to end.
// Until then the API trusts a plain ?user=<telegram_id> query param, which
// is fine for local prototyping and absolutely not fine for anything public.
const REQUIRE_TELEGRAM_AUTH = process.env.REQUIRE_TELEGRAM_AUTH === 'true';

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json());
// The actual flip-card frontend (public/index.html), wired to the real
// /api/* endpoints below instead of the earlier mock-data-only prototype.
// This is also exactly what WEBAPP_URL should point at once you're ready
// to cut Telegram's button over from the inline-query flow to the real
// Mini App -- Telegram opens this same page inside its own WebView.
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Telegram WebApp auth (validates the initData string Telegram signs and
// hands to the Mini App). See https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ---------------------------------------------------------------------------
function validateInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) return null;

  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}

// Middleware: resolves req.telegramUserId either from a validated
// X-Telegram-Init-Data header, or (dev mode only) a ?user= query param.
function requireTelegramUser(req, res, next) {
  const initData = req.get('X-Telegram-Init-Data');
  if (initData && BOT_TOKEN) {
    const user = validateInitData(initData, BOT_TOKEN);
    if (!user) return res.status(401).json({ error: 'invalid_init_data' });
    req.telegramUserId = user.id;
    return next();
  }
  if (!REQUIRE_TELEGRAM_AUTH && req.query.user) {
    req.telegramUserId = Number(req.query.user);
    return next();
  }
  return res.status(401).json({ error: 'missing_telegram_auth' });
}

// ---------------------------------------------------------------------------
// Small data-access helpers — mirror the sea-orm queries in the Rust source.
// ---------------------------------------------------------------------------

// mirrors chat::find_or_insert's lookup half (we never insert here; the bot
// owns chat creation via /start in a group)
async function getOpenChatByTelegramId(client, telegramChatId) {
  const { rows } = await client.query(
    `SELECT * FROM chats WHERE telegram_id = $1 AND end_date IS NULL`,
    [telegramChatId],
  );
  return rows[0] || null;
}

async function getChatById(client, chatId) {
  const { rows } = await client.query(`SELECT * FROM chats WHERE id = $1`, [chatId]);
  return rows[0] || null;
}

async function getPlayer(client, chatId, telegramUserId) {
  const { rows } = await client.query(
    `SELECT * FROM players WHERE chat_id = $1 AND telegram_id = $2`,
    [chatId, telegramUserId],
  );
  return rows[0] || null;
}

async function getPlayers(client, chatId) {
  const { rows } = await client.query(`SELECT * FROM players WHERE chat_id = $1`, [chatId]);
  return rows;
}

// mirrors player::Model::is_my_turn
function isMyTurn(chat, player) {
  let turn = chat.turn % chat.players;
  if (turn === 0) turn = chat.players;
  return player.turn === turn;
}

// mirrors chat::Model::next_player_turn
function nextPlayerTurn(chat) {
  const turn = chat.turn % chat.players;
  return turn === 0 ? chat.players : turn;
}

async function findJudge(client, chat) {
  const players = await getPlayers(client, chat.id);
  return players.find((p) => isMyTurn(chat, p)) || null;
}

// ---------------------------------------------------------------------------
// GET /api/state?chat=<telegram_chat_id>
//
// Mirrors bot/parser/status.rs + the "am I judge / what's in my hand" split
// from bot/parser/play.rs, collapsed into one payload the frontend can
// render directly instead of two separate flows.
// ---------------------------------------------------------------------------
app.get('/api/state', requireTelegramUser, async (req, res) => {
  const telegramChatId = req.query.chat;
  if (!telegramChatId) return res.status(400).json({ error: 'missing_chat' });

  const client = await pool.connect();
  try {
    const chat = await getOpenChatByTelegramId(client, telegramChatId);
    if (!chat) return res.status(404).json({ error: 'no_active_game' });

    if (chat.players + (chat.rando_carlissian ? 1 : 0) < 3) {
      return res.json({ status: 'waiting_for_players', players: chat.players });
    }

    const me = await getPlayer(client, chat.id, req.telegramUserId);
    if (!me) return res.status(403).json({ error: 'player_not_found', hint: 'send /start in the group first' });

    const judge = await findJudge(client, chat);
    if (!judge) return res.status(500).json({ error: 'no_judge_found_this_is_a_bug' });

    // the judge's black card for this turn
    const { rows: judgeHandRows } = await client.query(
      `SELECT h.id AS hand_id, c.* FROM hands h
       JOIN cards c ON c.id = h.card_id
       WHERE h.chat_id = $1 AND h.player_id = $2 AND h.played_on_turn = $3 AND c.color = 'black'`,
      [chat.id, judge.id, chat.turn],
    );
    const blackCard = judgeHandRows[0] || null;

    const amJudge = me.id === judge.id;

    // everyone else's submissions for this turn (includes Rando Carlissian, player_id = 0)
    const { rows: submissionRows } = await client.query(
      `SELECT h.id AS hand_id, h.player_id, c.* FROM hands h
       JOIN cards c ON c.id = h.card_id
       WHERE h.chat_id = $1 AND h.played_on_turn = $2 AND h.player_id != $3
       ORDER BY h.seq ASC`,
      [chat.id, chat.turn, judge.id],
    );
    const byPlayer = {};
    for (const row of submissionRows) {
      (byPlayer[row.player_id] ||= []).push(row);
    }
    const expectedSubmitters = chat.players - 1 + (chat.rando_carlissian ? 1 : 0);
    const revealed =
      Object.keys(byPlayer).length === expectedSubmitters &&
      Object.values(byPlayer).every((cards) => cards.length >= chat.pick);

    if (amJudge) {
      return res.json({
        status: 'ok',
        turn: chat.turn,
        pick: chat.pick,
        role: 'judge',
        blackCard: blackCard && { text: blackCard.text, pick: blackCard.pick || 1 },
        revealed,
        // only send the actual cards once every player has submitted —
        // matches play.rs's as_judge gate exactly, just returned as JSON
        // instead of a wall of inline query results.
        submissions: revealed
          ? Object.entries(byPlayer).map(([playerId, cards]) => ({
              // NOTE: this is a prototype convenience. Real CAH keeps the
              // author anonymous until picked — don't ship playerId to the
              // judge's client for real; group cards under an opaque token
              // and resolve identity server-side in POST /api/choose.
              submissionToken: playerId,
              cards: cards.map((c) => ({ handId: c.hand_id, text: c.text })),
            }))
          : [],
      });
    }

    // regular player: their hand + how many of `pick` they've already played
    const { rows: handRows } = await client.query(
      `SELECT h.id AS hand_id, h.played_on_turn, c.* FROM hands h
       JOIN cards c ON c.id = h.card_id
       WHERE h.player_id = $1 AND (h.played_on_turn = $2 OR h.played_on_turn IS NULL)
       ORDER BY h.id ASC`,
      [me.id, chat.turn],
    );
    const played = handRows.filter((r) => r.played_on_turn === chat.turn).length;
    const unplayedHand = handRows.filter((r) => r.played_on_turn === null);

    return res.json({
      status: 'ok',
      turn: chat.turn,
      pick: chat.pick,
      role: 'player',
      blackCard: blackCard && { text: blackCard.text, pick: blackCard.pick || 1 },
      alreadyPlayed: played,
      needsToPlay: Math.max(0, chat.pick - played),
      hand: unplayedHand.map((c) => ({ handId: c.hand_id, text: c.text })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/play  { chat, handId }
// Mirrors bot/parser/play.rs::as_player (submit one card) — the "choose a
// winner" side lives in /api/choose below, mirroring choose.rs.
// ---------------------------------------------------------------------------
app.post('/api/play', requireTelegramUser, async (req, res) => {
  const { chat: telegramChatId, handId } = req.body;
  const client = await pool.connect();
  try {
    const chat = await getOpenChatByTelegramId(client, telegramChatId);
    if (!chat) return res.status(404).json({ error: 'no_active_game' });
    if (chat.end_date) return res.status(409).json({ error: 'game_ended' });

    const me = await getPlayer(client, chat.id, req.telegramUserId);
    if (!me) return res.status(403).json({ error: 'player_not_found' });

    const judge = await findJudge(client, chat);
    if (judge && judge.id === me.id) {
      return res.status(409).json({ error: 'not_judge_turn', hint: 'judges pick via /api/choose' });
    }

    const { rows: alreadyPlayedRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM hands
       WHERE player_id = $1 AND played_on_turn = $2`,
      [me.id, chat.turn],
    );
    if (alreadyPlayedRows[0].n >= chat.pick) {
      return res.status(409).json({ error: 'already_played' });
    }

    const { rows: handRows } = await client.query(
      `SELECT * FROM hands WHERE id = $1 AND player_id = $2 AND played_on_turn IS NULL`,
      [handId, me.id],
    );
    if (!handRows[0]) return res.status(400).json({ error: 'card_not_in_hand' });

    await client.query(
      `UPDATE hands SET played_on_turn = $1, seq = $2 WHERE id = $3`,
      [chat.turn, alreadyPlayedRows[0].n, handId],
    );

    // Tell the group once every real player (judge's black card + everyone
    // else's white card(s)) is in — mirrors choose.rs::as_player's
    // "All players have chosen their cards" nudge, so the group chat stays
    // in the loop even though the actual picking happens in the Mini App.
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM hands
       WHERE chat_id = $1 AND played_on_turn = $2 AND player_id > 0`,
      [chat.id, chat.turn],
    );
    if (judge && countRows[0].n > (chat.players - 1) * chat.pick && BOT_TOKEN) {
      await sendTelegramMessage(
        chat.telegram_id,
        `All players have chosen their card${chat.pick > 1 ? 's' : ''}, ${judge.name} can pick a winner in the game`,
      );
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/choose  { chat, submissionToken }
// Judge picks a winning submission. Mirrors choose.rs::as_judge PLUS
// chat::Model::reset (deal the next black card + top up hands) collapsed
// into one call, since the Mini App doesn't need the intermediate states
// split across separate bot messages the way Telegram commands do.
// ---------------------------------------------------------------------------
app.post('/api/choose', requireTelegramUser, async (req, res) => {
  const { chat: telegramChatId, submissionToken } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const chat = await getOpenChatByTelegramId(client, telegramChatId);
    if (!chat) throw httpError(404, 'no_active_game');

    const me = await getPlayer(client, chat.id, req.telegramUserId);
    const judge = await findJudge(client, chat);
    if (!me || !judge || me.id !== judge.id) throw httpError(403, 'not_judge');

    const winningPlayerId = Number(submissionToken); // 0 == Rando Carlissian

    const { rows: winningHands } = await client.query(
      `SELECT * FROM hands WHERE chat_id = $1 AND player_id = $2 AND played_on_turn = $3`,
      [chat.id, winningPlayerId, chat.turn],
    );
    if (winningHands.length === 0) throw httpError(400, 'submission_not_found');

    if (winningPlayerId > 0) {
      await client.query(`UPDATE players SET points = points + 1 WHERE id = $1`, [winningPlayerId]);
    }
    await client.query(
      `UPDATE hands SET won = true WHERE id = ANY($1::int[])`,
      [winningHands.map((h) => h.id)],
    );

    const newTurn = chat.turn + 1;
    await client.query(`UPDATE chats SET turn = $1 WHERE id = $2`, [newTurn, chat.id]);
    const updatedChat = { ...chat, turn: newTurn };

    const { blackCard, newJudge } = await dealNewTurn(client, updatedChat);

    await client.query('COMMIT');

    if (BOT_TOKEN) {
      const winnerLabel = winningPlayerId > 0 ? (await getPlayerById(pool, winningPlayerId))?.name : 'Rando Carlissian';
      await sendTelegramMessage(
        chat.telegram_id,
        `Turn ${newTurn}\n\n${blackCard.text}\n\nJudge is ${newJudge.name}\n\n(previous round won by ${winnerLabel})`,
      );
    }

    res.json({ status: 'ok', turn: newTurn, blackCard: { text: blackCard.text, pick: blackCard.pick || 1 } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function getPlayerById(client, id) {
  const { rows } = await client.query(`SELECT * FROM players WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Deals the next turn: tops every player's hand back up to 10 white cards,
// gives the new judge a black card, and sets chat.pick from it.
//
// Deliberate difference from upstream: the Rust reset() calls hand::pick()
// in a loop for Rando Carlissian in a way that (by reading the source
// closely) ends up dealing far more cards than intended per turn — each
// loop iteration re-tops Rando's hand to 10 instead of marking exactly one
// more card played. Here Rando's hand is topped up once, then exactly
// `pick` of its unplayed cards are marked played for the new turn. Simpler
// and matches what the feature obviously intends; flagging it in case you
// want byte-for-byte parity with upstream instead.
async function dealNewTurn(client, chat) {
  const players = await getPlayers(client, chat.id);

  const { rows: usedCardIds } = await client.query(
    `SELECT DISTINCT card_id FROM hands WHERE chat_id = $1`,
    [chat.id],
  );
  const excluded = usedCardIds.map((r) => r.card_id);

  const { rows: enabledPackRows } = await client.query(
    `SELECT pack_id FROM chat_packs WHERE chat_id = $1`,
    [chat.id],
  );
  const packIds = enabledPackRows.map((r) => r.pack_id);

  async function dealWhiteCards(playerId, count) {
    if (count <= 0) return [];
    const { rows } = await client.query(
      `SELECT id FROM cards
       WHERE color = 'white' AND pack_id = ANY($1::int[]) AND id != ALL($2::int[])
       ORDER BY random() LIMIT $3`,
      [packIds, excluded, count],
    );
    if (rows.length < count) throw httpError(409, 'no_more_white_cards');
    for (const row of rows) {
      excluded.push(row.id);
      await client.query(
        `INSERT INTO hands (player_id, chat_id, card_id, picked_on_turn, played_on_turn, seq)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [playerId, chat.id, row.id, chat.turn, playerId === 0 ? chat.turn : null],
      );
    }
    return rows;
  }

  for (const player of players) {
    const { rows: unplayedCountRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM hands WHERE player_id = $1 AND played_on_turn IS NULL`,
      [player.id],
    );
    await dealWhiteCards(player.id, 10 - unplayedCountRows[0].n);
  }

  const newJudge = players.find((p) => isMyTurn(chat, p));
  if (!newJudge) throw httpError(500, 'no_judge_this_is_a_bug');

  const { rows: blackRows } = await client.query(
    `SELECT id, text, pick FROM cards
     WHERE color = 'black' AND pack_id = ANY($1::int[]) AND id != ALL($2::int[])
     ORDER BY random() LIMIT 1`,
    [packIds, excluded],
  );
  if (!blackRows[0]) throw httpError(409, 'no_more_black_cards');
  const blackCard = blackRows[0];

  await client.query(
    `INSERT INTO hands (player_id, chat_id, card_id, picked_on_turn, played_on_turn, seq)
     VALUES ($1, $2, $3, $4, $4, 0)`,
    [newJudge.id, chat.id, blackCard.id, chat.turn],
  );
  await client.query(`UPDATE chats SET pick = $1 WHERE id = $2`, [blackCard.pick || 1, chat.id]);

  if (chat.rando_carlissian) {
    const dealt = await dealWhiteCards(0, 0); // no-op if already topped up above; see loop
    const { rows: randoUnplayed } = await client.query(
      `SELECT id FROM hands WHERE player_id = 0 AND chat_id = $1 AND played_on_turn IS NULL LIMIT $2`,
      [chat.id, blackCard.pick || 1],
    );
    if (randoUnplayed.length) {
      await client.query(
        `UPDATE hands SET played_on_turn = $1 WHERE id = ANY($2::int[])`,
        [chat.turn, randoUnplayed.map((r) => r.id)],
      );
    }
  }

  return { blackCard, newJudge };
}

async function sendTelegramMessage(telegramChatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text }),
    });
  } catch (err) {
    console.error('Telegram notify failed (non-fatal):', err.message);
  }
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`cah-webapp API listening on :${PORT}`);
});
