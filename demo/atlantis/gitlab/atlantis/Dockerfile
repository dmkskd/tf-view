# syntax=docker/dockerfile:1
# Stage 1: the tfview binary, built for Alpine. It embeds dist/index.html, so run `just build` first (just up does).
FROM rust:alpine AS tfview
RUN apk add --no-cache musl-dev
WORKDIR /src/cli
COPY --from=repo cli/Cargo.toml cli/Cargo.lock cli/build.rs ./
COPY --from=repo cli/src ./src
COPY --from=repo cli/prompts ./prompts
COPY --from=repo dist/index.html /src/dist/index.html
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/cli/target \
    cargo build --release && cp target/release/tfview /tfview

FROM ghcr.io/runatlantis/atlantis:latest
USER root
RUN apk add --no-cache curl jq
# Node alternative to the binary (see report.sh): also uncomment the COPY of inject.js below
# RUN apk add --no-cache nodejs
# Optional: Chromium renders a screenshot of the plan into the MR comment. Skip with --build-arg PLAN_IMAGE=off
ARG PLAN_IMAGE=on
RUN if [ "$PLAN_IMAGE" = on ]; then apk add --no-cache chromium font-noto; fi
COPY --from=tfview /tfview /usr/local/bin/tfview
# COPY shared/inject.js /opt/tfplanview/inject.js
USER atlantis
