# CHANGED from upstream: the original Dockerfile did its own
# `git clone https://github.com/nappa85/cah_bot.git` inside the build step,
# which ignored whatever build context Coolify/Compose handed it — your own
# fork's changes (this WebApp button patch included) would never actually
# get built, no matter what repo the compose file pointed at. This version
# builds from the real build context instead, so editing this fork and
# redeploying actually does something.
FROM rust:bullseye AS builder

WORKDIR /app

COPY . .
RUN cargo build --release

FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/cah_bot /usr/local/bin/cah_bot

RUN chmod +x /usr/local/bin/cah_bot

WORKDIR /usr/local/bin/

CMD ["cah_bot"]
