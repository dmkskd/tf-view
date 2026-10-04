FROM ghcr.io/runatlantis/atlantis:latest
USER root
RUN apk add --no-cache nodejs curl jq
COPY inject.js /opt/tfplanview/inject.js
USER atlantis
