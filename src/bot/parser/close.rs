use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter,
    StreamTrait,
};
use tgbot::{
    api::Client,
    types::{ParseMode, ReplyParameters, SendMessage, User},
};

use crate::{
    entities::{chat, player},
    Error,
};

#[derive(thiserror::Error, Debug)]
pub enum CloseError {
    #[error("You're not the game owner, only {0} can use this command")]
    NotOwner(String),
    #[error(transparent)]
    Chat(#[from] chat::ChatError),
}

pub async fn execute<C>(
    client: &Client,
    conn: &C,
    user: &User,
    message_id: i64,
    chat: &chat::Model,
) -> Result<Result<(), CloseError>, Error>
where
    C: ConnectionTrait + StreamTrait,
{
    let Some(player) = player::Entity::find()
        .filter(
            player::Column::TelegramId
                .eq(i64::from(user.id))
                .and(player::Column::ChatId.eq(chat.id)),
        )
        .one(conn)
        .await?
    else {
        return Ok(Ok(()));
    };

    if chat.owner != Some(player.id) {
        let Some(owner) = player::Entity::find_by_id(chat.owner.unwrap_or_default())
            .one(conn)
            .await?
        else {
            return Ok(Ok(()));
        };

        return Ok(Err(CloseError::NotOwner(owner.tg_link())));
    }

    let msg = if chat.turn <= 1 {
        // The game never got past the first hand (e.g. only the owner ever
        // joined). chat.close() tallies points and bails with
        // ChatError::Empty when nobody has scored yet, so the old code just
        // refused to close at all here -- which left the owner stuck:
        // /start won't re-add someone who's already a player on this chat,
        // and /close wouldn't end it either. End it directly instead; there
        // are no scores to tally yet, so there's nothing chat.close() would
        // have done besides error out.
        chat::ActiveModel {
            id: ActiveValue::Set(chat.id),
            end_date: ActiveValue::Set(Some(Utc::now().naive_utc())),
            ..Default::default()
        }
        .update(conn)
        .await?;

        "Game closed before it started \\(no rounds played\\)".to_string()
    } else {
        match chat.close(conn).await? {
            Ok(msg) => msg,
            Err(e) => return Ok(Err(CloseError::from(e))),
        }
    };

    client
        .execute(
            SendMessage::new(chat.telegram_id, msg)
                .with_reply_parameters(ReplyParameters::new(message_id))
                .with_parse_mode(ParseMode::MarkdownV2),
        )
        .await?;

    Ok(Ok(()))
}
