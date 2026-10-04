FROM alpine:3
RUN apk add --no-cache bash curl git jq docker-cli
COPY setup.sh demo.sh /
RUN chmod +x /setup.sh /demo.sh
ENTRYPOINT ["/setup.sh"]
