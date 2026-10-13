FROM nginx:1.27-alpine

# Defaults for Docker Compose; Kubernetes overrides these in k8s/gateway.yaml.
ENV DNS_RESOLVER=127.0.0.11 \
    SHORTENER_HOST=shortener \
    REDIRECT_HOST=redirect \
    ANALYTICS_HOST=analytics

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY public /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
