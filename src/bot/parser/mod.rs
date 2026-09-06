use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, StreamTrait, TransactionTrait,
};
use tgbot::{
    api::Client,
    types::{
        AnswerInlineQuery, Chat, InlineKeyboardButton, MaybeInaccessibleMessage, ParseMode,
        ReplyParameters, SendMessage, User, WebAppInfo,
    },
};
use tracing::warn;

use crate::{
    entities::{chat, hand, player},
    Error,
};

mod choose;
mod close;
mod help;
mod play;
mod rank;
mod settings;
mod start;
mod status;

/// Builds the "Open cards hand" button attached to the GROUP status
/// message. This always uses switch_inline_query, never the Mini App.
///
/// Telegram documents `web_app` on InlineKeyboardButton as "available only
/// in private chats between a user and the bot"
/// (https://core.telegram.org/bots/api#inlinekeyboardbutton). Attaching one
/// to a message sent to a GROUP gets the whole message (text included)
/// rejected with a 400, which bot::clear_error() then treats as safe to
/// ignore -- that's exactly the bug that made /start and /status go
/// silent the first time WEBAPP_URL got set to anything. The real Mini App
/// button is DM'd to individual players instead -- see
/// `dm_all_players_webapp` / `dm_player_webapp` below.
pub(crate) fn play_button(chat_id: i32) -> InlineKeyboardButton {
    InlineKeyboardButton::for_switch_inline_query_current_chat(
        "Open cards hand",
        chat_id.to_string(),
    )
}

/// DMs a single player the real Mini App button. `telegram_id` here is
/// always a player's own Telegram user id -- in Telegram, a private chat's
/// id IS that same user id, so this is the one context where `web_app`
/// buttons are actually legal.
///
/// Errors are swallowed on purpose: the likely failure is "Forbidden: bot
/// can't initiate conversation with a user", which just means this player
/// has never opened a private chat with the bot. That's not fatal -- the
/// group message still carries the switch_inline_query fallback button, so
/// the game keeps moving for everyone else either way.
async fn dm_webapp_button(client: &Client, base: &str, chat_id: i32, telegram_id: i64, text: &str) {
    let sep = if base.contains('?') { '&' } else { '?' };
    if let Err(e) = client
        .execute(
            SendMessage::new(telegram_id, text)
                .with_reply_markup([[InlineKeyboardButton::for_web_app(
                    "Open cards hand",
                    WebAppInfo {
                        url: format!("{base}{sep}chat={chat_id}"),
                    },
                )]])
                .with_parse_mode(ParseMode::MarkdownV2),
        )
        .await
    {
        warn!(
            "Couldn't DM player {telegram_id} their webapp hand link \
             (they probably haven't opened a private chat with the bot yet): {e}"
        );
    }
}

/// DMs every player in `chat` the real Mini App button, when one is
/// configured. Used at the moments a new round actually starts: at that
/// point everyone either has cards to submit or (the judge) will soon need
/// to pick a winner, and the webapp itself renders the right view per role
/// once it authenticates the opener via Telegram's initData.
pub(crate) async fn dm_all_players_webapp<C>(
    client: &Client,
    conn: &C,
    webapp_url: Option<&str>,
    chat: &chat::Model,
    text: &str,
) -> Result<(), Error>
where
    C: ConnectionTrait,
{
    let Some(base) = webapp_url else {
        return Ok(());
    };
    let players = player::Entity::find()
        .filter(player::Column::ChatId.eq(chat.id))
        .all(conn)
        .await?;
    for player in players {
        dm_webapp_button(client, base, chat.id, player.telegram_id, text).await;
    }
    Ok(())
}

/// DMs one specific player (e.g. whoever just ran /status, or the judge once
/// everyone else has submitted) the real Mini App button.
pub(crate) async fn dm_player_webapp(
    client: &Client,
    webapp_url: Option<&str>,
    chat_id: i32,
    telegram_id: i64,
    text: &str,
) {
    if let Some(base) = webapp_url {
        dm_webapp_button(client, base, chat_id, telegram_id, text).await;
    }
}

#[derive(thiserror::Error, Debug)]
enum BotError {
    #[error(transparent)]
    Chat(#[from] chat::ChatError),
    #[error(transparent)]
    Hand(#[from] hand::PickError),
    #[error(transparent)]
    Start(#[from] start::StartError),
    #[error(transparent)]
    Settings(#[from] settings::SettingsError),
    #[error(transparent)]
    Status(#[from] status::StatusError),
    #[error(transparent)]
    Close(#[from] close::CloseError),
}

pub async fn parse_message<C>(
    client: &Client,
    conn: &C,
    name: &str,
    user: &User,
    message_id: i64,
    msg: &str,
    tg_chat: &Chat,
    webapp_url: Option<&str>,
) -> Result<(), Error>
where
    C: ConnectionTrait + StreamTrait + TransactionTrait,
{
    let res = match chat::find_or_insert(conn, tg_chat).await? {
        Ok(chat) => {
            let mut iter = msg.split_whitespace();
            match iter.next().map(|msg| msg.strip_suffix(name).unwrap_or(msg)) {
                Some("/help") => {
                    Ok(help::execute(client, message_id, &chat, name, webapp_url).await?)
                }
                Some("/start") => start::execute(client, conn, user, message_id, &chat, webapp_url)
                    .await?
                    .map_err(BotError::from),
                Some("/settings") => {
                    settings::execute(client, conn, user, message_id, &chat, None, webapp_url)
                        .await?
                        .map_err(BotError::from)
                }
                Some("/status") => {
                    status::execute(client, conn, user, message_id, &chat, webapp_url)
                        .await?
                        .map_err(BotError::from)
                }
                Some("/rank") => Ok(rank::execute(client, conn, message_id, &chat).await?),
                Some("/close") => close::execute(client, conn, user, message_id, &chat)
                    .await?
                    .map_err(BotError::from),
                _ => return Ok(()),
            }
        }
        Err(e) => Err(BotError::from(e)),
    };

    if let Err(err) = res {
        client
            .execute(
                SendMessage::new(tg_chat.get_id(), format!("Error: {err}"))
                    .with_reply_parameters(ReplyParameters::new(message_id))
                    .with_parse_mode(ParseMode::MarkdownV2),
            )
            .await?;
    }

    Ok(())
}

pub async fn parse_callback_query<C>(
    client: &Client,
    conn: &C,
    user: &User,
    message: &MaybeInaccessibleMessage,
    data: &str,
    webapp_url: Option<&str>,
) -> Result<(), Error>
where
    C: ConnectionTrait + StreamTrait + TransactionTrait,
{
    let (tg_chat, message_id) = match message {
        MaybeInaccessibleMessage::InaccessibleMessage(im) => (&im.chat, im.message_id),
        MaybeInaccessibleMessage::Message(m) => (&m.chat, m.id),
    };

    let res = match chat::find_or_insert(conn, tg_chat).await? {
        Ok(chat) => {
            settings::execute(client, conn, user, message_id, &chat, Some(data), webapp_url)
                .await?
                .map_err(BotError::from)
        }
        Err(e) => Err(BotError::from(e)),
    };

    if let Err(err) = res {
        client
            .execute(
                SendMessage::new(tg_chat.get_id(), format!("Error: {err}"))
                    .with_reply_parameters(ReplyParameters::new(message_id))
                    .with_parse_mode(ParseMode::MarkdownV2),
            )
            .await?;
    }

    Ok(())
}

pub async fn parse_inline_query<C>(
    client: &Client,
    conn: &C,
    user: &User,
    query_id: &str,
    msg: &str,
) -> Result<(), Error>
where
    C: ConnectionTrait + StreamTrait + TransactionTrait,
{
    if let Err(err) = parse_inline_query_inner(client, conn, user, query_id, msg).await? {
        client
            .execute(AnswerInlineQuery::new(query_id, err).with_cache_time(0))
            .await?;
    }

    Ok(())
}

async fn parse_inline_query_inner<C>(
    client: &Client,
    conn: &C,
    user: &User,
    query_id: &str,
    msg: &str,
) -> Result<Result<(), play::PlayError>, Error>
where
    C: ConnectionTrait + StreamTrait + TransactionTrait,
{
    let Ok(chat_id) = msg.parse::<i32>() else {
        return Ok(Err(play::PlayError::Clear));
    };
    let Some(chat) = chat::Entity::find_by_id(chat_id).one(conn).await? else {
        return Ok(Err(play::PlayError::Clear));
    };

    play::execute(client, conn, user, query_id, &chat).await
}

pub async fn parse_inline_query_response<C>(
    client: &Client,
    conn: &C,
    user: &User,
    result_id: &str,
    webapp_url: Option<&str>,
) -> Result<(), Error>
where
    C: ConnectionTrait + StreamTrait + TransactionTrait,
{
    // remove anything after a ';' then split it by whitespace and convert to i32
    let Ok(hand_ids) = result_id
        .split_once(';')
        .map(|(s, _)| s)
        .unwrap_or(result_id)
        .split_whitespace()
        .map(|s| s.parse::<i32>())
        .collect::<Result<Vec<_>, _>>()
    else {
        return Ok(());
    };
    if hand_ids.is_empty() {
        return Ok(());
    }

    let len = hand_ids.len();
    let hands = hand::Entity::find()
        .filter(hand::Column::Id.is_in(hand_ids))
        .all(conn)
        .await?;
    if hands.len() != len {
        return Ok(());
    }

    choose::execute(client, conn, user, &hands, webapp_url).await
}
