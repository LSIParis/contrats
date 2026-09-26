# syntax=docker/dockerfile:1
#
# Service OCR interne de l'application « Contrats » : ocrmypdf + Tesseract
# (français) derrière un mini-serveur HTTP en Python (bibliothèque standard).
# Joignable uniquement sur le réseau interne de la stack (http://ocr:8080),
# jamais publié. Aucune donnée ne sort du VPS.
#
# Base Debian stable plutôt que l'image jbarlow83/ocrmypdf : paquets signés
# Debian, langue `fra` explicite, image plus petite et épinglable.
# Épinglée par digest. ⚠ Le dependabot.yml de l'annexe A ne surveille que le
# Dockerfile racine : ce digest se met à jour à la main (09-exploitation.md).
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG SOURCE_URL=https://github.com/LSIParis/contrats
LABEL org.opencontainers.image.title="contrats-ocr" \
      org.opencontainers.image.description="OCR interne (ocrmypdf + Tesseract fra) de l'application Contrats" \
      org.opencontainers.image.vendor="LSI-Maintenance" \
      org.opencontainers.image.source="${SOURCE_URL}"

# ocrmypdf tire python3, ghostscript, qpdf, pikepdf et tesseract-ocr ;
# tesseract-ocr-fra apporte le modèle français. Pas de recommandés (pas de
# modèles de langue superflus, pas d'outils graphiques).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ocrmypdf \
      tesseract-ocr \
      tesseract-ocr-fra \
      ghostscript \
      poppler-utils \
      pngquant \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && tesseract --list-langs | grep -qx fra

# Utilisateur dédié sans shell de connexion ni répertoire modifiable hors /tmp.
RUN groupadd --system --gid 10001 ocr \
 && useradd --system --uid 10001 --gid ocr --no-create-home --shell /usr/sbin/nologin ocr

WORKDIR /srv/ocr
COPY server.py ./

# OMP_THREAD_LIMIT=1 : Tesseract multi-thread par page + ocrmypdf
# multi-process = sur-souscription CPU ; on parallélise par requête.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OCR_PORT=8080 \
    OCR_MAX_BYTES=52428800 \
    OCR_TIMEOUT_SECONDS=300 \
    OCR_LANG=fra \
    OCR_JOBS=1 \
    OCR_MAX_CONCURRENCY=2 \
    OMP_THREAD_LIMIT=1

USER ocr
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('OCR_PORT','8080'), timeout=3)" || exit 1

CMD ["python3", "/srv/ocr/server.py"]
