FROM ghcr.io/runatlantis/atlantis:latest
USER root
RUN apk add --no-cache nodejs curl jq
# Optional: Chromium renders a screenshot of the plan into the MR comment. Skip with --build-arg PLAN_IMAGE=off
ARG PLAN_IMAGE=on
RUN if [ "$PLAN_IMAGE" = on ]; then apk add --no-cache chromium font-noto; fi
COPY shared/inject.js /opt/tfplanview/inject.js
USER atlantis
