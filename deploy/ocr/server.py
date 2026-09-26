"""Service OCR interne de l'application « Contrats ».

Mini-serveur HTTP (bibliothèque standard uniquement) qui enveloppe `ocrmypdf`
+ Tesseract (langue `fra`). Il n'écoute que sur le réseau interne de la stack
et n'est jamais publié.

    GET  /health  -> 200 {"status": "ok"}
    POST /ocr     corps application/pdf
                  -> 200 {"text": "...", "pages": N, "pdfBase64": "<PDF recherchable>"}
                  -> 4xx/5xx {"error": "<code>", "detail": "<message>"}

L'original n'est jamais modifié : l'appelant (worker) conserve le PDF déposé
et son empreinte SHA-256 ; la copie recherchable renvoyée ici est un document
distinct (brief §3).

Confidentialité : aucun contenu de document (octets, texte reconnu, sortie
d'ocrmypdf) n'est écrit dans les logs. Seuls la méthode, le chemin, le statut,
la taille et la durée le sont.

Configuration (variables d'environnement) :
    OCR_PORT              port d'écoute (8080)
    OCR_BIND              adresse d'écoute (0.0.0.0, réseau Docker interne)
    OCR_MAX_BYTES         taille maximale du PDF reçu (52428800 = 50 Mo)
    OCR_TIMEOUT_SECONDS   durée maximale d'un OCR avant abandon (300)
    OCR_LANG              langues Tesseract (fra)
    OCR_JOBS              parallélisme interne d'ocrmypdf par requête (1)
    OCR_MAX_CONCURRENCY   requêtes OCR simultanées ; au-delà -> 503 (2)
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = logging.getLogger("ocr")

# Codes de sortie d'ocrmypdf (ocrmypdf.ExitCode).
EXIT_INPUT_FILE = 2
EXIT_ENCRYPTED_PDF = 8
# Pages déjà porteuses de texte : ocrmypdf écrit ce marqueur dans le sidecar.
SKIPPED_MARKER = re.compile(r"\[OCR skipped on page\(s\) [^\]]*\]")


@dataclass(frozen=True)
class Config:
    port: int = 8080
    bind: str = "0.0.0.0"
    max_bytes: int = 50 * 1024 * 1024
    timeout_seconds: float = 300.0
    lang: str = "fra"
    jobs: int = 1
    max_concurrency: int = 2

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        env = dict(os.environ if env is None else env)
        return cls(
            port=int(env.get("OCR_PORT", "8080")),
            bind=env.get("OCR_BIND", "0.0.0.0"),
            max_bytes=int(env.get("OCR_MAX_BYTES", str(50 * 1024 * 1024))),
            timeout_seconds=float(env.get("OCR_TIMEOUT_SECONDS", "300")),
            lang=env.get("OCR_LANG", "fra"),
            jobs=int(env.get("OCR_JOBS", "1")),
            max_concurrency=int(env.get("OCR_MAX_CONCURRENCY", "2")),
        )


class OcrError(Exception):
    """Erreur renvoyée au client : statut HTTP + code stable + détail sans donnée."""

    def __init__(self, status: HTTPStatus, code: str, detail: str):
        super().__init__(code)
        self.status = status
        self.code = code
        self.detail = detail


def count_pages(pdf_path: Path) -> int:
    """Nombre de pages du PDF produit.

    pikepdf est une dépendance d'ocrmypdf, donc présent dans l'image. Repli sur
    un comptage des objets /Type /Page si l'import échoue (tests, poste local).
    """
    try:
        import pikepdf  # type: ignore[import-not-found]

        with pikepdf.open(pdf_path) as pdf:
            return len(pdf.pages)
    except ImportError:
        data = pdf_path.read_bytes()
        return len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", data))


def extract_text(pdf_path: Path, config: Config) -> str:
    """Texte de la couche texte du PDF (pdftotext, poppler-utils)."""
    try:
        proc = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", str(pdf_path), "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=config.timeout_seconds,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise OcrError(
            HTTPStatus.INTERNAL_SERVER_ERROR, "text_extraction_failed", "extraction du texte impossible"
        ) from exc
    if proc.returncode != 0:
        LOG.warning("pdftotext a échoué (code de sortie %s)", proc.returncode)
        raise OcrError(
            HTTPStatus.INTERNAL_SERVER_ERROR, "text_extraction_failed", "extraction du texte impossible"
        )
    return proc.stdout.decode("utf-8", errors="replace")


def run_ocr(pdf: bytes, config: Config) -> dict:
    """Exécute ocrmypdf dans un répertoire temporaire, supprimé en sortie."""
    with tempfile.TemporaryDirectory(prefix="ocr-") as tmp:
        work = Path(tmp)
        src, out, sidecar = work / "in.pdf", work / "out.pdf", work / "out.txt"
        src.write_bytes(pdf)
        cmd = [
            "ocrmypdf",
            "--skip-text",  # pages déjà textuelles conservées telles quelles
            "-l", config.lang,
            "--sidecar", str(sidecar),
            "--output-type", "pdf",  # pas de conversion PDF/A : copie de travail
            "--jobs", str(config.jobs),
            "--quiet",
            str(src),
            str(out),
        ]
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,  # capturé pour ne PAS l'écrire dans les logs
                timeout=config.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise OcrError(
                HTTPStatus.GATEWAY_TIMEOUT,
                "ocr_timeout",
                f"OCR interrompu après {config.timeout_seconds:g} s",
            ) from exc
        except FileNotFoundError as exc:
            raise OcrError(
                HTTPStatus.INTERNAL_SERVER_ERROR, "ocr_unavailable", "ocrmypdf introuvable"
            ) from exc

        if proc.returncode == EXIT_ENCRYPTED_PDF:
            raise OcrError(
                HTTPStatus.UNPROCESSABLE_ENTITY, "encrypted_pdf", "PDF chiffré ou protégé par mot de passe"
            )
        if proc.returncode == EXIT_INPUT_FILE:
            raise OcrError(
                HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_pdf", "PDF illisible ou corrompu"
            )
        if proc.returncode != 0 or not out.is_file():
            LOG.warning("ocrmypdf a échoué (code de sortie %s)", proc.returncode)
            raise OcrError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "ocr_failed",
                f"ocrmypdf a échoué (code {proc.returncode})",
            )

        raw_text = sidecar.read_text(encoding="utf-8", errors="replace") if sidecar.is_file() else ""
        if SKIPPED_MARKER.search(raw_text):
            # Des pages portaient déjà du texte (PDF natif ou déjà océrisé) :
            # ocrmypdf ne met dans le sidecar qu'un marqueur pour elles. Le PDF
            # de sortie a désormais une couche texte sur TOUTES les pages : on
            # l'extrait d'un bloc (pages séparées par \f, comme le sidecar).
            text = extract_text(out, config)
        else:
            text = raw_text
        return {
            "text": text,
            "pages": count_pages(out),
            "pdfBase64": base64.b64encode(out.read_bytes()).decode("ascii"),
        }


class OcrHandler(BaseHTTPRequestHandler):
    server_version = "contrats-ocr/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # Injectés par make_server().
    config: Config
    slots: threading.Semaphore

    # --- plomberie ---------------------------------------------------------
    def log_message(self, format: str, *args) -> None:  # noqa: A002 (signature imposée)
        # BaseHTTPRequestHandler journalise la ligne de requête ; on la remplace
        # par notre propre ligne d'accès (sans contenu) dans _access().
        return

    def _access(self, status: int, size: int, started: float) -> None:
        LOG.info(
            "%s %s %d %dB %.0fms",
            self.command,
            self.path.split("?", 1)[0],
            status,
            size,
            (time.monotonic() - started) * 1000,
        )

    def _send_json(self, status: HTTPStatus, payload: dict, started: float, size_in: int = 0) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == HTTPStatus.SERVICE_UNAVAILABLE:
            self.send_header("Retry-After", "10")
        self.end_headers()
        self.wfile.write(body)
        self._access(int(status), size_in, started)

    def _send_error(self, err: OcrError, started: float, size_in: int = 0) -> None:
        self._send_json(err.status, {"error": err.code, "detail": err.detail}, started, size_in)

    # --- routes ------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        started = time.monotonic()
        if self.path.split("?", 1)[0] == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"}, started)
        else:
            self.close_connection = True
            self._send_error(OcrError(HTTPStatus.NOT_FOUND, "not_found", "route inconnue"), started)

    def do_POST(self) -> None:  # noqa: N802
        started = time.monotonic()
        # Toute réponse d'erreur ferme la connexion : le corps éventuellement non
        # lu ne doit pas être interprété comme une requête suivante.
        if self.path.split("?", 1)[0] != "/ocr":
            self.close_connection = True
            self._send_error(OcrError(HTTPStatus.NOT_FOUND, "not_found", "route inconnue"), started)
            return
        try:
            pdf = self._read_pdf()
        except OcrError as err:
            self.close_connection = True
            self._send_error(err, started)
            return

        if not self.slots.acquire(blocking=False):
            self._send_error(
                OcrError(HTTPStatus.SERVICE_UNAVAILABLE, "busy", "trop d'OCR en cours, réessayer"),
                started,
                len(pdf),
            )
            return
        try:
            result = run_ocr(pdf, self.config)
        except OcrError as err:
            self._send_error(err, started, len(pdf))
            return
        except Exception:  # noqa: BLE001 — jamais de trace (elle pourrait citer le document)
            LOG.error("erreur interne inattendue pendant l'OCR")
            self._send_error(
                OcrError(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", "erreur interne"),
                started,
                len(pdf),
            )
            return
        finally:
            self.slots.release()
        self._send_json(HTTPStatus.OK, result, started, len(pdf))

    def _read_pdf(self) -> bytes:
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/pdf":
            raise OcrError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "Content-Type attendu : application/pdf"
            )
        if self.headers.get("Transfer-Encoding"):
            raise OcrError(HTTPStatus.LENGTH_REQUIRED, "length_required", "Content-Length obligatoire")
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            raise OcrError(HTTPStatus.LENGTH_REQUIRED, "length_required", "Content-Length obligatoire")
        try:
            length = int(raw_len)
        except ValueError as exc:
            raise OcrError(HTTPStatus.BAD_REQUEST, "bad_request", "Content-Length invalide") from exc
        if length <= 0:
            raise OcrError(HTTPStatus.BAD_REQUEST, "empty_body", "corps vide")
        if length > self.config.max_bytes:
            raise OcrError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "payload_too_large",
                f"PDF supérieur à {self.config.max_bytes} octets",
            )
        data = self.rfile.read(length)
        if len(data) != length:
            raise OcrError(HTTPStatus.BAD_REQUEST, "incomplete_body", "corps tronqué")
        if not data.startswith(b"%PDF-"):
            raise OcrError(HTTPStatus.BAD_REQUEST, "invalid_pdf", "le corps n'est pas un PDF")
        return data


def make_server(config: Config) -> ThreadingHTTPServer:
    handler = type(
        "ConfiguredOcrHandler",
        (OcrHandler,),
        {"config": config, "slots": threading.Semaphore(config.max_concurrency)},
    )
    server = ThreadingHTTPServer((config.bind, config.port), handler)
    server.daemon_threads = True
    return server


def main() -> None:
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config = Config.from_env()
    server = make_server(config)
    LOG.info(
        "écoute sur %s:%d (max %d octets, délai %gs, langue %s)",
        config.bind,
        config.port,
        config.max_bytes,
        config.timeout_seconds,
        config.lang,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
