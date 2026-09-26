"""Tests du service OCR : gestion des requêtes, sans OCR réel.

`subprocess.run` est remplacé par un faux qui écrit les fichiers qu'ocrmypdf
produirait (PDF de sortie + sidecar texte). Aucun binaire externe n'est requis.

Lancement (hors suite Node) :
    cd deploy/ocr && python -m unittest -v
"""

from __future__ import annotations

import base64
import http.client
import json
import logging
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import server

MINIMAL_PDF = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
)
OUTPUT_PDF = MINIMAL_PDF.replace(b"%%EOF", b"%searchable\n%%EOF")
SECRET_TEXT = "CONTRAT DE MAINTENANCE — client confidentiel Dupont SARL"


def fake_ocrmypdf(
    returncode: int = 0,
    text: str = SECRET_TEXT,
    write_output: bool = True,
    pdftotext: str = "",
    pdftotext_rc: int = 0,
):
    """Faux subprocess.run : écrit sortie et sidecar aux chemins de la commande."""
    calls: list[list[str]] = []

    def _run(cmd, **kwargs):
        calls.append(list(cmd))
        if cmd[0] == "pdftotext":
            return subprocess.CompletedProcess(cmd, pdftotext_rc, stdout=pdftotext.encode(), stderr=b"")
        if write_output and returncode == 0:
            sidecar = Path(cmd[cmd.index("--sidecar") + 1])
            sidecar.write_text(text, encoding="utf-8")
            Path(cmd[-1]).write_bytes(OUTPUT_PDF)
        return subprocess.CompletedProcess(cmd, returncode, stdout=None, stderr=b"stderr " + text.encode())

    return _run, calls


class OcrServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = server.Config(
            port=0, bind="127.0.0.1", max_bytes=4096, timeout_seconds=7, lang="fra", jobs=1, max_concurrency=1
        )
        self.httpd = server.make_server(self.config)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None), resp
        finally:
            conn.close()

    def post_pdf(self, body: bytes = MINIMAL_PDF, ctype: str = "application/pdf"):
        return self.request("POST", "/ocr", body, {"Content-Type": ctype})

    # --- santé et routage --------------------------------------------------
    def test_health(self):
        status, payload, _ = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"status": "ok"})

    def test_unknown_route_is_404_json(self):
        status, payload, _ = self.request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "not_found")
        status, payload, _ = self.request("POST", "/other", MINIMAL_PDF, {"Content-Type": "application/pdf"})
        self.assertEqual(status, 404)

    # --- validation de la requête -------------------------------------------
    def test_rejects_wrong_content_type(self):
        status, payload, _ = self.post_pdf(ctype="application/json")
        self.assertEqual(status, 415)
        self.assertEqual(payload["error"], "unsupported_media_type")
        self.assertIn("detail", payload)

    def test_accepts_content_type_with_parameters(self):
        run, _ = fake_ocrmypdf()
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, _, _ = self.post_pdf(ctype="application/pdf; charset=binary")
        self.assertEqual(status, 200)

    def test_rejects_oversized_body_without_running_ocr(self):
        with mock.patch.object(server.subprocess, "run") as run:
            status, payload, _ = self.post_pdf(body=b"%PDF-" + b"x" * 5000)
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"], "payload_too_large")
        run.assert_not_called()

    def test_rejects_non_pdf_body(self):
        with mock.patch.object(server.subprocess, "run") as run:
            status, payload, _ = self.post_pdf(body=b"hello world")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_pdf")
        run.assert_not_called()

    def test_requires_content_length(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/ocr")
            conn.putheader("Content-Type", "application/pdf")
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            conn.send(b"0\r\n\r\n")
            resp = conn.getresponse()
            payload = json.loads(resp.read())
        finally:
            conn.close()
        self.assertEqual(resp.status, 411)
        self.assertEqual(payload["error"], "length_required")

    # --- exécution d'ocrmypdf ----------------------------------------------
    def test_success_returns_text_pages_and_searchable_pdf(self):
        run, calls = fake_ocrmypdf(text="Page un\fPage deux\n")
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, resp = self.post_pdf()
        self.assertEqual(status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "application/json; charset=utf-8")
        self.assertEqual(payload["text"], "Page un\fPage deux\n")
        self.assertEqual(payload["pages"], 1)
        self.assertEqual(base64.b64decode(payload["pdfBase64"]), OUTPUT_PDF)

        self.assertEqual(len(calls), 1)  # pas d'extraction complémentaire
        cmd = calls[0]
        self.assertEqual(cmd[0], "ocrmypdf")
        self.assertIn("--skip-text", cmd)
        self.assertEqual(cmd[cmd.index("-l") + 1], "fra")
        self.assertIn("--sidecar", cmd)

    def test_pages_with_existing_text_are_extracted_from_output(self):
        run, calls = fake_ocrmypdf(
            text="Page un\f[OCR skipped on page(s) 2]\f", pdftotext="Page un\fTexte natif page deux\f"
        )
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 200)
        self.assertEqual(payload["text"], "Page un\fTexte natif page deux\f")
        self.assertEqual(calls[1][0], "pdftotext")

    def test_text_extraction_failure_maps_to_500(self):
        run, _ = fake_ocrmypdf(text="[OCR skipped on page(s) 1]", pdftotext_rc=1)
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "text_extraction_failed")

    def test_passes_timeout_and_never_uses_a_shell(self):
        run, _ = fake_ocrmypdf()
        with mock.patch.object(server.subprocess, "run", side_effect=run) as spy:
            self.post_pdf()
        kwargs = spy.call_args.kwargs
        self.assertEqual(kwargs["timeout"], 7)
        self.assertFalse(kwargs.get("shell", False))

    def test_temp_directory_is_removed(self):
        seen: list[Path] = []
        run, _ = fake_ocrmypdf()

        def spy(cmd, **kwargs):
            seen.append(Path(cmd[-1]).parent)
            return run(cmd, **kwargs)

        with mock.patch.object(server.subprocess, "run", side_effect=spy):
            self.post_pdf()
        self.assertTrue(seen)
        self.assertFalse(seen[0].exists())
        self.assertTrue(str(seen[0]).startswith(tempfile.gettempdir()))

    def test_timeout_maps_to_504(self):
        def boom(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

        with mock.patch.object(server.subprocess, "run", side_effect=boom):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 504)
        self.assertEqual(payload["error"], "ocr_timeout")

    def test_encrypted_pdf_maps_to_422(self):
        run, _ = fake_ocrmypdf(returncode=8)
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 422)
        self.assertEqual(payload["error"], "encrypted_pdf")

    def test_unreadable_pdf_maps_to_422(self):
        run, _ = fake_ocrmypdf(returncode=2)
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 422)
        self.assertEqual(payload["error"], "invalid_pdf")

    def test_other_failure_maps_to_500(self):
        run, _ = fake_ocrmypdf(returncode=15)
        with mock.patch.object(server.subprocess, "run", side_effect=run):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "ocr_failed")

    def test_missing_binary_maps_to_500(self):
        with mock.patch.object(server.subprocess, "run", side_effect=FileNotFoundError("ocrmypdf")):
            status, payload, _ = self.post_pdf()
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "ocr_unavailable")

    def test_busy_when_concurrency_exhausted(self):
        self.httpd.RequestHandlerClass.slots.acquire()
        try:
            with mock.patch.object(server.subprocess, "run") as run:
                status, payload, resp = self.post_pdf()
        finally:
            self.httpd.RequestHandlerClass.slots.release()
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "busy")
        self.assertEqual(resp.getheader("Retry-After"), "10")
        run.assert_not_called()

    # --- confidentialité ----------------------------------------------------
    def test_never_logs_document_content(self):
        run, _ = fake_ocrmypdf(returncode=15)
        run_ok, _ = fake_ocrmypdf()
        with self.assertLogs("ocr", level=logging.DEBUG) as logs:
            with mock.patch.object(server.subprocess, "run", side_effect=run):
                self.post_pdf()
            with mock.patch.object(server.subprocess, "run", side_effect=run_ok):
                self.post_pdf()
        joined = "\n".join(logs.output)
        self.assertNotIn("Dupont", joined)
        self.assertNotIn("stderr", joined)
        self.assertNotIn("%PDF", joined)
        self.assertIn("POST /ocr 200", joined)


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        cfg = server.Config.from_env({})
        self.assertEqual(cfg.port, 8080)
        self.assertEqual(cfg.max_bytes, 50 * 1024 * 1024)
        self.assertEqual(cfg.lang, "fra")

    def test_overrides(self):
        cfg = server.Config.from_env({"OCR_MAX_BYTES": "1000", "OCR_TIMEOUT_SECONDS": "12.5", "OCR_LANG": "fra+eng"})
        self.assertEqual(cfg.max_bytes, 1000)
        self.assertEqual(cfg.timeout_seconds, 12.5)
        self.assertEqual(cfg.lang, "fra+eng")


if __name__ == "__main__":
    unittest.main()
