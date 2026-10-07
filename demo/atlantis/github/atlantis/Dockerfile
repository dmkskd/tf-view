FROM ghcr.io/runatlantis/atlantis:latest
USER root
RUN apk add --no-cache nodejs curl jq
# gh posts the plan comment and uploads the screenshot into it (`gh pr comment --attach`, gh >= 2.99)
ARG GH_VERSION=2.102.0
ARG TARGETARCH
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /tmp && mv /tmp/gh_*/bin/gh /usr/local/bin/gh && gh --version
# Optional: Chromium renders a screenshot of the plan into the comment. Skip with --build-arg PLAN_IMAGE=off
ARG PLAN_IMAGE=on
RUN if [ "$PLAN_IMAGE" = on ]; then apk add --no-cache chromium font-noto; fi
COPY shared/inject.js /opt/tfplanview/inject.js
USER atlantis
