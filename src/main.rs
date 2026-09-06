use std::env;

use sea_orm::{Database, DbErr};
use tgbot::api::{ClientError, ExecuteError};

mod bot;
mod entities;
mod utils;

const PACKS: &str = include_str!("../cah-cards-full.json");
static RANDO_CARLISSIAN: &str = "Rando Carlissian";

// those are all unrecoverable errors
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Missing env var BOT_TOKEN")]
    MissingBotToken,
    #[error("Missing env var BOT_NAME")]
    MissingBotName,
    #[error("Sea-orm error: {0}")]
    SeaOrm(#[from] DbErr),
    #[error("Telegram client error: {0}")]
    TelegramClient(#[from] ClientError),
    #[error("Telegram execute error: {0}")]
    TelegramExec(#[from] ExecuteError),
    #[error("Serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt::init();

    let token = env::var("BOT_TOKEN").map_err(|_| Error::MissingBotToken)?;
    let name = env::var("BOT_NAME").map_err(|_| Error::MissingBotName)?;
    let name = format!("@{}", name.strip_prefix('@').unwrap_or(name.as_str()));
    let conn = Database::connect("postgres://postgres:postgres@postgres/cah_bot").await?;

    // Optional: base URL of the Telegram Mini App front-end (e.g.
    // "https://cah.example.com"). When unset, every "Open cards hand"
    // button falls back to the original inline-query flow exactly as
    // before -- this is purely additive.
    //
    // Filtering out an empty string matters: Docker Compose's
    // `${WEBAPP_URL:-}` substitution always sets the env var, just to ""
    // when nothing's configured upstream -- it never leaves it unset. That
    // turned into a silent, live bug: `env::var(..).ok()` gave `Some("")`,
    // so bot::parser::play_button() took the "webapp configured" branch and
    // built a Web App button URL of "?chat=<id>" -- a URL with no host.
    // Telegram rejects the WHOLE message (text included, not just the
    // button) with a 400 for that, and bot::clear_error() treats every 400
    // as safe to ignore, so /start and /status silently dropped their
    // entire response, confirmation text and all, with no visible error.
    let webapp_url = env::var("WEBAPP_URL")
        .ok()
        .filter(|url| !url.is_empty());

    entities::pack::init(&conn).await?;

    bot::execute(&conn, token, &name, webapp_url.as_deref()).await
}
