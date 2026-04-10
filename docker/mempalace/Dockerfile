FROM python:3.13-slim

ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "mempalace>=2,<4" "starlette>=0.40,<1" "uvicorn>=0.30,<1"

# Create a mempalace user with configurable UID/GID to match host user
RUN groupadd -g $USER_GID mempalace \
  && useradd -u $USER_UID -g $USER_GID -m -s /usr/sbin/nologin mempalace

COPY serve_http.py /app/serve_http.py
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV MEMPALACE_PALACE_PATH=/data/mempalace
ENV MEMPALACE_PORT=8080
ENV USER_UID=${USER_UID}
ENV USER_GID=${USER_GID}
EXPOSE 8080

VOLUME ["/data/mempalace"]
RUN mkdir -p /data/mempalace && chown mempalace:mempalace /data/mempalace

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "/app/serve_http.py"]
