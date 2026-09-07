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
// Same var the Rust bot reads to build its own DM buttons (main.rs). Needed
// here too: /api/play and /api/choose advance the game from INSIDE the Mini
// App, so unlike the Rust bot's command handlers they have no incoming
// message to reply to -- they have to build a fresh "Open cards hand" link
// themselves to DM the next player(s), the same way bot/parser/mod.rs's
// dm_all_players_webapp / dm_player_webapp do on the Rust side.
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres/cah_bot';
// Set to "true" once you've wired real Telegram WebApp auth end to end.
// Until then the API trusts a plain ?user=<telegram_id> query param, which
// is fine for local prototyping and absolutely not fine for anything public.
const REQUIRE_TELEGRAM_AUTH = process.env.REQUIRE_TELEGRAM_AUTH === 'true';

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json());
// GET /api/state is polled every 4s with an IDENTICAL url each time (same
// chat, same query string) while a game is in progress. That's exactly the
// shape of request a browser/WebView HTTP cache is most tempted to reuse
// instead of re-fetching -- and this project has already been bitten once
// this session by Telegram's WebView caching a Mini App response it had no
// business caching. Belt-and-suspenders: tell every client outright never
// to cache these, on top of the client also passing cache: 'no-store'.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
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

// The `chat` query/body param this whole API takes is ALWAYS the internal
// `chats.id` primary key -- the same id bot/parser/mod.rs's play_button()
// bakes into the Mini App button's URL (`?chat={chat_id}` there, using
// chat.id, never chat.telegram_id). It is NOT the Telegram group chat id.
// Those two numbers look interchangeable (both small ints) but are not --
// this file used to look chats up by telegram_id here, which meant every
// single request 404'd with no_active_game since a real internal id will
// essentially never collide with a real Telegram group id.
async function getOpenChatById(client, chatId) {
  const { rows } = await client.query(
    `SELECT * FROM chats WHERE id = $1 AND end_date IS NULL`,
    [chatId],
  );
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

// Fetches this turn's non-judge submissions grouped by player, PLUS a
// deterministic-but-unpredictable ordering over the submitting player ids.
// Used to build the judge's anonymous view (GET /api/state) and to resolve
// a pick back to a real player (POST /api/choose) without ever putting a
// real player_id in front of the judge's client.
//
// The order is derived from sha256(`${chat.id}:${chat.turn}:${playerId}`)
// rather than raw player_id or submission order -- either of those would
// leak identity over time: player_id is the same every turn for a given
// player, and submission order alone tends to correlate with who tends to
// answer fast/slow. Hashing in the turn number means the order reshuffles
// every turn with no relation to anything the judge could learn.
async function getAnonymizedSubmissions(client, chat, judgeId) {
  const { rows: submissionRows } = await client.query(
    `SELECT h.id AS hand_id, h.player_id, c.* FROM hands h
     JOIN cards c ON c.id = h.card_id
     WHERE h.chat_id = $1 AND h.played_on_turn = $2 AND h.player_id != $3
     ORDER BY h.seq ASC`,
    [chat.id, chat.turn, judgeId],
  );
  const byPlayer = {};
  for (const row of submissionRows) {
    (byPlayer[row.player_id] ||= []).push(row);
  }
  const rank = (playerId) =>
    crypto.createHash('sha256').update(`${chat.id}:${chat.turn}:${playerId}`).digest('hex');
  const playerIds = Object.keys(byPlayer)
    .map(Number)
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
  return { byPlayer, playerIds };
}

// Finds who won the round just before this one (chat.turn - 1), if any.
// POST /api/choose already stamps `won = true` on the winning hand row(s)
// when it advances the turn -- this just reads that back, so no extra
// state needs to live anywhere. Lets EVERY client (not just the judge who
// actually clicked "crown winner") show a "so-and-so won!" celebration the
// next time they poll, even though the pick itself happens privately
// inside POST /api/choose with no broadcast of its own.
async function getPreviousWinner(client, chat) {
  if (chat.turn <= 1) return null;
  const { rows } = await client.query(
    `SELECT h.player_id, c.text FROM hands h
     JOIN cards c ON c.id = h.card_id
     WHERE h.chat_id = $1 AND h.played_on_turn = $2 AND h.won = true
     ORDER BY h.seq ASC`,
    [chat.id, chat.turn - 1],
  );
  if (!rows.length) return null;
  const winningPlayerId = rows[0].player_id;
  const cardText = rows.map((r) => r.text).join(' / ');
  let name = 'Rando Carlissian';
  if (winningPlayerId > 0) {
    const player = await getPlayerById(client, winningPlayerId);
    name = player ? player.name : 'Somebody';
  }
  return { turn: chat.turn - 1, name, cardText };
}

// ---------------------------------------------------------------------------
// GET /api/state?chat=<internal chats.id, NOT the Telegram group id>
//
// Mirrors bot/parser/status.rs + the "am I judge / what's in my hand" split
// from bot/parser/play.rs, collapsed into one payload the frontend can
// render directly instead of two separate flows.
// ---------------------------------------------------------------------------
app.get('/api/state', requireTelegramUser, async (req, res) => {
  const chatId = req.query.chat;
  if (!chatId) return res.status(400).json({ error: 'missing_chat' });

  const client = await pool.connect();
  try {
    const chat = await getOpenChatById(client, chatId);
    if (!chat) return res.status(404).json({ error: 'no_active_game' });

    if (chat.players + (chat.rando_carlissian ? 1 : 0) < 3) {
      return res.json({ status: 'waiting_for_players', players: chat.players });
    }

    const me = await getPlayer(client, chat.id, req.telegramUserId);
    if (!me) return res.status(403).json({ error: 'player_not_found', hint: 'send /start in the group first' });

    const judge = await findJudge(client, chat);
    if (!judge) return res.status(500).json({ error: 'no_judge_found_this_is_a_bug' });

    const previousWinner = await getPreviousWinner(client, chat);

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
    const { byPlayer, playerIds } = await getAnonymizedSubmissions(client, chat, judge.id);
    const expectedSubmitters = chat.players - 1 + (chat.rando_carlissian ? 1 : 0);
    const revealed =
      playerIds.length === expectedSubmitters &&
      playerIds.every((pid) => byPlayer[pid].length >= chat.pick);

    if (amJudge) {
      return res.json({
        status: 'ok',
        turn: chat.turn,
        pick: chat.pick,
        role: 'judge',
        blackCard: blackCard && { text: blackCard.text, pick: blackCard.pick || 1 },
        previousWinner,
        revealed,
        // only send the actual cards once every player has submitted —
        // matches play.rs's as_judge gate exactly, just returned as JSON
        // instead of a wall of inline query results.
        //
        // submissionToken is just this submission's position in
        // getAnonymizedSubmissions' per-turn shuffle -- never a real
        // player_id. POST /api/choose recomputes the same shuffle and maps
        // the index back to a player server-side, so identity never touches
        // the judge's client at all.
        submissions: revealed
          ? playerIds.map((pid, index) => ({
              submissionToken: String(index),
              cards: byPlayer[pid].map((c) => ({ handId: c.hand_id, text: c.text })),
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
      previousWinner,
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
// POST /api/play  { chat: <internal chats.id>, handId }
// Mirrors bot/parser/play.rs::as_player (submit one card) — the "choose a
// winner" side lives in /api/choose below, mirroring choose.rs.
// ---------------------------------------------------------------------------
app.post('/api/play', requireTelegramUser, async (req, res) => {
  const { chat: chatId, handId } = req.body;
  const client = await pool.connect();
  try {
    const chat = await getOpenChatById(client, chatId);
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
        groupFallbackMarkup(chat.id),
      );
      // The judge is the only one with anything to do now -- DM just them a
      // fresh Mini App link (mirrors choose.rs::as_player's dm_player_webapp).
      await dmWebAppButton(
        judge.telegram_id,
        chat.id,
        'All players have submitted, open the app to pick the winner',
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
// POST /api/choose  { chat: <internal chats.id>, submissionToken }
// Judge picks a winning submission. Mirrors choose.rs::as_judge PLUS
// chat::Model::reset (deal the next black card + top up hands) collapsed
// into one call, since the Mini App doesn't need the intermediate states
// split across separate bot messages the way Telegram commands do.
// ---------------------------------------------------------------------------
app.post('/api/choose', requireTelegramUser, async (req, res) => {
  const { chat: chatId, submissionToken } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const chat = await getOpenChatById(client, chatId);
    if (!chat) throw httpError(404, 'no_active_game');

    const me = await getPlayer(client, chat.id, req.telegramUserId);
    const judge = await findJudge(client, chat);
    if (!me || !judge || me.id !== judge.id) throw httpError(403, 'not_judge');

    // submissionToken is a position in the same per-turn shuffle GET
    // /api/state handed the judge, not a real player_id -- resolve it the
    // same way here so a crafted/guessed token can only ever point at a
    // real submission from this exact turn, never an arbitrary player.
    const { byPlayer, playerIds } = await getAnonymizedSubmissions(client, chat, judge.id);
    const index = Number(submissionToken);
    if (!Number.isInteger(index) || index < 0 || index >= playerIds.length) {
      throw httpError(400, 'submission_not_found');
    }
    const winningPlayerId = playerIds[index]; // 0 == Rando Carlissian
    const winningHands = byPlayer[winningPlayerId];
    if (!winningHands || winningHands.length === 0) throw httpError(400, 'submission_not_found');

    if (winningPlayerId > 0) {
      await client.query(`UPDATE players SET points = points + 1 WHERE id = $1`, [winningPlayerId]);
    }
    await client.query(
      // winningHands rows come from getAnonymizedSubmissions' join with
      // cards, so the hand's own id is aliased as hand_id there -- h.id on
      // these rows is actually the CARD id (from cards.*), not the hand.
      `UPDATE hands SET won = true WHERE id = ANY($1::int[])`,
      [winningHands.map((h) => h.hand_id)],
    );

    const newTurn = chat.turn + 1;
    await client.query(`UPDATE chats SET turn = $1 WHERE id = $2`, [newTurn, chat.id]);
    const updatedChat = { ...chat, turn: newTurn };

    const { blackCard, newJudge } = await dealNewTurn(client, updatedChat);

    await client.query('COMMIT');

    // Computed regardless of BOT_TOKEN (unlike the Telegram notify below)
    // because the judge's OWN client needs this in the response right now,
    // to run its own winner celebration immediately instead of waiting on
    // the next poll -- see GET /api/state's getPreviousWinner(), which every
    // OTHER player's client uses to catch the same celebration a few
    // seconds later without ever having called /api/choose themselves.
    const winnerLabel = winningPlayerId > 0
      ? (await getPlayerById(pool, winningPlayerId))?.name || 'Somebody'
      : 'Rando Carlissian';
    const winningCardText = winningHands.map((h) => h.text).join(' / ');

    if (BOT_TOKEN) {
      await sendTelegramMessage(
        chat.telegram_id,
        `Turn ${newTurn}\n\n${blackCard.text}\n\nJudge is ${newJudge.name}\n\n(previous round won by ${winnerLabel})`,
        groupFallbackMarkup(chat.id),
      );
      // New round -- DM everyone a fresh Mini App link (mirrors
      // bot/parser/mod.rs's dm_all_players_webapp usage in choose.rs::as_judge).
      // Without this, nobody but whoever already had a tab open and polling
      // ever found out the round advanced.
      await dmAllPlayersWebapp(pool, chat.id, 'New round started, open your hand to play');
    }

    res.json({
      status: 'ok',
      turn: newTurn,
      blackCard: { text: blackCard.text, pick: blackCard.pick || 1 },
      previousWinner: { turn: chat.turn, name: winnerLabel, cardText: winningCardText },
    });
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
      // BUG #2 (found while writing the integration test for BUG #1's fix
      // below): this used to write `playerId === 0 ? chat.turn : null` here
      // -- meaning every card freshly dealt to Rando (player_id 0) got
      // inserted ALREADY marked played_on_turn = chat.turn, instead of
      // unplayed like a real player's fresh cards. That's wrong for two
      // reasons: (1) it hands the judge a "submission" of 9-10 cards bundled
      // as one player instead of exactly `pick`, which is almost certainly
      // why the judge's card grid renders broken/invisible once Rando's
      // dealt in; (2) it means Rando's hand hits 0 unplayed at the end of
      // EVERY single round, forcing a full fresh deal of up to 10 cards next
      // round instead of drawing down 1-2 at a time like a real player --
      // burning through the pack's white cards roughly 10x too fast and
      // risking a hard `no_more_white_cards` failure mid-game. Always insert
      // unplayed (null) here; the explicit UPDATE further down is what
      // correctly marks exactly `pick` of Rando's unplayed cards played for
      // the new turn, exactly mirroring a real player.
      await client.query(
        `INSERT INTO hands (player_id, chat_id, card_id, picked_on_turn, played_on_turn, seq)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [playerId, chat.id, row.id, chat.turn, null],
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
    // BUG (this was the actual cause of the judge's screen hanging forever
    // with no cards to reveal): this used to call dealWhiteCards(0, 0) --
    // a hardcoded zero, always a no-op -- on the theory that Rando's hand
    // was "already topped up above." It never was: the loop above only
    // iterates `players`, i.e. getPlayers()'s real rows, and Rando has no
    // row in the players table, ever -- it's purely the player_id = 0
    // sentinel in `hands`. So Rando's hand was never refilled by this
    // function, only ever drawn down. It happened to work for a round or
    // two on whatever stash Rust's chat::reset() originally dealt it, then
    // ran dry -- at which point this SELECT below started finding zero (or
    // fewer than `pick`) unplayed rows, no hand ever got marked played for
    // Rando that turn, and getAnonymizedSubmissions() in GET /api/state
    // could never see the expected number of submitters -- revealed stays
    // false forever, no "refresh" fixes it. Fixed by actually topping
    // Rando back up to 10, mirroring the real-player loop above exactly.
    const { rows: randoUnplayedCountRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM hands WHERE player_id = 0 AND chat_id = $1 AND played_on_turn IS NULL`,
      [chat.id],
    );
    await dealWhiteCards(0, 10 - randoUnplayedCountRows[0].n);

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

async function sendTelegramMessage(telegramChatId, text, replyMarkup) {
  try {
    const body = { chat_id: telegramChatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Telegram notify failed (non-fatal):', err.message);
  }
}

// Same switch_inline_query_current_chat button bot/parser/mod.rs's
// play_button() attaches to every group message the Rust bot sends -- see
// that function's own comment for why a GROUP message can never carry a
// web_app button. Attaching it here too means anyone whose DM hasn't landed
// yet (they've never opened a private chat with the bot) still has a way
// into the old inline-query flow instead of being stuck with nothing.
function groupFallbackMarkup(chatId) {
  return {
    inline_keyboard: [[{ text: 'Open cards hand', switch_inline_query_current_chat: String(chatId) }]],
  };
}

// DMs one player the real Mini App button -- mirrors bot/parser/mod.rs's
// dm_webapp_button. This (and dmAllPlayersWebapp below) is what was missing
// here: /api/play and /api/choose advance the game from INSIDE the Mini App
// itself, so unlike the Rust bot's command handlers there's no incoming
// Telegram message to reply to -- nothing was ever telling the NEXT
// player(s) a new round/turn even started unless their tab happened to
// already be open and polling. Failures are swallowed on purpose: the usual
// cause is "Forbidden: bot can't initiate conversation with a user" (they've
// never DM'd the bot), which isn't fatal -- the group message's fallback
// button above still gets them into the old inline flow.
async function dmWebAppButton(telegramId, chatId, text) {
  if (!WEBAPP_URL || !BOT_TOKEN) return;
  const sep = WEBAPP_URL.includes('?') ? '&' : '?';
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        reply_markup: {
          inline_keyboard: [[{ text: 'Open cards hand', web_app: { url: `${WEBAPP_URL}${sep}chat=${chatId}` } }]],
        },
      }),
    });
  } catch (err) {
    console.error(`Couldn't DM player ${telegramId} their webapp hand link (non-fatal):`, err.message);
  }
}

// DMs every player in the chat a fresh Mini App link -- mirrors
// bot/parser/mod.rs's dm_all_players_webapp. Used at the same moment the
// Rust bot uses it: right when a new round actually starts, since the
// webapp itself works out judge-vs-player from who's asking (GET
// /api/state), so one identical link works for everyone.
async function dmAllPlayersWebapp(client, chatId, text) {
  if (!WEBAPP_URL || !BOT_TOKEN) return;
  const players = await getPlayers(client, chatId);
  await Promise.all(players.map((p) => dmWebAppButton(p.telegram_id, chatId, text)));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`cah-webapp API listening on :${PORT}`);
});
