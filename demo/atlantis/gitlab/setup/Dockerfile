FROM alpine:3
RUN apk add --no-cache bash curl git jq docker-cli
COPY gitlab/setup/setup.sh gitlab/setup/demo.sh shared/revisions.sh /
RUN chmod +x /setup.sh /demo.sh
ENTRYPOINT ["/setup.sh"]
