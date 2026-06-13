# syntax=docker/dockerfile:1.7

FROM caddy:2-alpine

ARG VERSION=""

ENV PORT=8080

COPY Caddyfile.template /etc/caddy/Caddyfile.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY index.html /srv/index.html
COPY css/ /srv/css/
COPY js/ /srv/js/

RUN if [ -n "$VERSION" ]; then \
        printf '{"version":"%s"}\n' "$VERSION" > /srv/version.json; \
    fi

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
