"""Internet-facing ASGI app exposing only the formula comparator allowlist."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Route
from starlette.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from .public_copy import PUBLIC_COPY
from .public_copy_en import PUBLIC_COPY_EN
from .public_catalog_i18n import localise_catalog
from .service import FormulaPriceComparatorService, FormulaWebInputError, PRODUCT_VERSION


ROOT = Path(__file__).resolve().parents[3]
WEB_DIR = Path(__file__).resolve().parents[1] / "web"
TEMPLATES = Jinja2Templates(directory=str(WEB_DIR / "templates"))
STATIC_DIR = WEB_DIR / "static"
MAX_REQUEST_BYTES = 64 * 1024
PUBLIC_SITE_URL = "https://tender-lab.com"
ASSET_VERSION = "20261016-input-steps-v1"
ASSET_RECOVERY_SCRIPT = """(() => {
  "use strict";
  const retryKey = "tenderlab-analysis-assets-retry";
  const retry = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("_assets", String(Date.now()));
    window.location.replace(url);
  };
  const showFailure = () => {
    if (document.querySelector("#formula-assets-error")) return;
    const alert = document.createElement("section");
    alert.id = "formula-assets-error";
    alert.className = "fp-assets-error";
    alert.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = document.documentElement.lang === "en"
      ? "The complete application could not be loaded."
      : "No se ha podido cargar la aplicación completa.";
    const detail = document.createElement("p");
    detail.textContent = document.documentElement.lang === "en"
      ? "Check your connection and try again."
      : "Comprueba la conexión y vuelve a intentarlo.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = document.documentElement.lang === "en" ? "Try again" : "Reintentar";
    button.addEventListener("click", () => {
      try { window.sessionStorage.removeItem(retryKey); } catch (_error) {}
      retry();
    });
    alert.append(title, detail, button);
    document.body.prepend(alert);
  };
  window.setTimeout(() => {
    const stylesheet = document.querySelector("link[data-formula-stylesheet]");
    const cssReady = stylesheet && Array.from(document.styleSheets).some(
      (sheet) => sheet.href === stylesheet.href
    );
    const appReady = document.documentElement.dataset.formulaAppReady === "true";
    if (cssReady && appReady) {
      try { window.sessionStorage.removeItem(retryKey); } catch (_error) {}
      const cleanUrl = new URL(window.location.href);
      if (cleanUrl.searchParams.delete("_assets")) {
        window.history.replaceState({}, "", cleanUrl);
      }
      return;
    }
    let alreadyRetried = false;
    try {
      alreadyRetried = window.sessionStorage.getItem(retryKey) === "1";
      window.sessionStorage.setItem(retryKey, "1");
    } catch (_error) {}
    if (alreadyRetried) showFailure();
    else retry();
  }, 10000);
})();"""
ASSET_RECOVERY_HASH = base64.b64encode(
    hashlib.sha256(ASSET_RECOVERY_SCRIPT.encode("utf-8")).digest()
).decode("ascii")


class SecurityHeadersMiddleware:
    """Set a closed browser policy without introducing third-party dependencies."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        async def send_with_headers(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", ()))
                headers.extend(
                    [
                        (
                            b"content-security-policy",
                            (
                                "default-src 'self'; "
                                f"script-src 'self' 'sha256-{ASSET_RECOVERY_HASH}'; "
                                "style-src 'self'; img-src 'self' data:; connect-src 'self'; "
                                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
                                "form-action 'self'"
                            ).encode("ascii"),
                        ),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
                        (b"cross-origin-opener-policy", b"same-origin"),
                    ]
                )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


def _service(request: Request) -> FormulaPriceComparatorService:
    return request.app.state.formula_service


def _locale(request: Request) -> str:
    return "en" if request.url.path == "/en" or request.url.path.startswith("/en/") else "es"


def _copy(request: Request) -> dict[str, Any]:
    return PUBLIC_COPY_EN if _locale(request) == "en" else PUBLIC_COPY


def _translated_path(path: str, locale: str) -> str:
    routes = {
        "/formulas": "/en/formulas",
        "/formulas/analizador": "/en/formulas/analyzer",
        "/formulas/laboratorio": "/en/formulas/laboratory",
        "/informacion-legal": "/en/legal",
    }
    if locale == "es":
        return routes.get(path, "/en/formulas")
    reverse = {value: key for key, value in routes.items()}
    return reverse.get(path, "/formulas")


def _page_kind(path: str) -> str:
    if path.endswith(("/analizador", "/analyzer")):
        return "analysis"
    if path.endswith(("/laboratorio", "/laboratory")):
        return "lab"
    if path.endswith(("/informacion-legal", "/legal")):
        return "legal"
    return "landing"


def _page_context(request: Request) -> dict[str, Any]:
    locale = _locale(request)
    copy = _copy(request)
    catalog = localise_catalog(_service(request).public_catalog(), locale)
    feedback_url = str(catalog.get("author", {}).get("linkedin_url", ""))
    catalog["feedback_url"] = feedback_url
    catalog["feedback_urls"] = {
        reason: feedback_url
        for reason in ("feedback", "formula", "caso", "privacidad")
    }
    for internal_key in ("product_version", "engine_version", "canonical_catalog_version"):
        catalog.pop(internal_key, None)
    catalog["release_label"] = copy["common"]["release_label"]
    catalog["locale"] = locale
    catalog["number_locale"] = "en-GB" if locale == "en" else "es-ES"
    catalog["editorial"] = {
        "analysis_profiles": copy["analysis"]["profiles"],
        "analysis_simulation": {
            key: value for key, value in copy["analysis"].items()
            if key.startswith("simulation_")
        },
        "analysis_chart": {
            key: value for key, value in copy["analysis"].items()
            if key.startswith("detail_zoom_")
        },
        "analysis_report": {
            key: value for key, value in copy["analysis"].items()
            if key.startswith("report_")
        },
        "analysis_runtime": copy["analysis"]["runtime"],
        "lab_runtime": copy["lab"]["runtime"],
    }
    catalog["api_url"] = f"/api/formula-price-comparator/compare?lang={locale}"
    if locale == "en":
        catalog["home_url"] = "/en/formulas"
        catalog["analyzer_url"] = "/en/formulas/analyzer"
        catalog["lab_url"] = "/en/formulas/laboratory"
        catalog["legal_url"] = "/en/legal"
    else:
        catalog["home_url"] = "/formulas"
        catalog["analyzer_url"] = "/formulas/analizador"
        catalog["lab_url"] = "/formulas/laboratorio"
        catalog["legal_url"] = "/informacion-legal"
    requested_path = request.url.path
    canonical_path = catalog["home_url"] if requested_path in {"/", "/en"} else requested_path
    alternate_path = _translated_path(canonical_path, locale)
    spanish_path = canonical_path if locale == "es" else alternate_path
    page_copy = copy[_page_kind(canonical_path)]
    retry_token = request.query_params.get("_assets", "")
    retry_suffix = f"&retry={retry_token}" if retry_token.isdigit() else ""
    return {
        "request": request,
        "catalog": catalog,
        "home_url": catalog["home_url"],
        "analyzer_url": catalog["analyzer_url"],
        "lab_url": catalog["lab_url"],
        "legal_url": catalog["legal_url"],
        "copy": copy,
        "locale": locale,
        "alternate_locale": "es" if locale == "en" else "en",
        "alternate_url": _translated_path(request.url.path, locale) + (
            f"?{request.url.query}" if request.url.query else ""
        ),
        "canonical_url": f"{PUBLIC_SITE_URL}{canonical_path}",
        "alternate_canonical_url": f"{PUBLIC_SITE_URL}{alternate_path}",
        "x_default_url": f"{PUBLIC_SITE_URL}{spanish_path}",
        "seo_title": page_copy.get("seo_title") or page_copy.get("page_title") or str(catalog["title"]),
        "seo_description": page_copy["meta_description"],
        "seo_site_name": copy["common"]["seo_site_name"],
        "og_locale": "en_GB" if locale == "en" else "es_ES",
        "og_alternate_locale": "es_ES" if locale == "en" else "en_GB",
        "stylesheet_url": f"/static/formula-public.css?v={ASSET_VERSION}{retry_suffix}",
        "format_script_url": f"/static/formula-format.js?v={ASSET_VERSION}{retry_suffix}",
    }


def formula_page(request: Request) -> Response:
    context = _page_context(request)
    context.update(
        {
            "venn_image_url": f"/static/formula-venn-header.png?v={ASSET_VERSION}",
            "equations_image_url": f"/static/formula-equations-strip.png?v={ASSET_VERSION}",
        }
    )
    return TEMPLATES.TemplateResponse(
        request=request,
        name="formula_public_landing.html",
        context=context,
        headers={"Cache-Control": "no-store"},
    )


def formula_analysis_page(request: Request) -> Response:
    context = _page_context(request)
    retry_token = request.query_params.get("_assets", "")
    retry_suffix = f"&retry={retry_token}" if retry_token.isdigit() else ""
    context["script_url"] = f"/static/formula-public-analysis.js?v={ASSET_VERSION}{retry_suffix}"
    context["asset_recovery_script"] = ASSET_RECOVERY_SCRIPT
    return TEMPLATES.TemplateResponse(
        request=request,
        name="formula_analysis.html",
        context=context,
        headers={"Cache-Control": "no-store"},
    )


def formula_lab_page(request: Request) -> Response:
    context = _page_context(request)
    context["lab_script_url"] = f"/static/formula-lab.js?v={ASSET_VERSION}"
    return TEMPLATES.TemplateResponse(
        request=request,
        name="formula_lab.html",
        context=context,
        headers={"Cache-Control": "no-store"},
    )


def legal_page(request: Request) -> Response:
    return TEMPLATES.TemplateResponse(
        request=request,
        name="formula_legal.html",
        context=_page_context(request),
        headers={"Cache-Control": "no-store"},
    )


def contact_redirect(request: Request) -> Response:
    linkedin_url = str(_service(request).public_catalog()["author"]["linkedin_url"])
    return RedirectResponse(linkedin_url, status_code=302)


def root_redirect(request: Request) -> Response:
    return RedirectResponse("/en/formulas" if _locale(request) == "en" else "/formulas", status_code=308)


def robots(_: Request) -> Response:
    return PlainTextResponse(
        "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\n"
        f"Sitemap: {PUBLIC_SITE_URL}/sitemap.xml\n"
    )


def sitemap(_: Request) -> Response:
    pairs = (
        ("/formulas", "/en/formulas"),
        ("/formulas/analizador", "/en/formulas/analyzer"),
        ("/formulas/laboratorio", "/en/formulas/laboratory"),
        ("/informacion-legal", "/en/legal"),
    )
    entries = []
    for spanish, english in pairs:
        alternates = (
            f'<xhtml:link rel="alternate" hreflang="es" href="{PUBLIC_SITE_URL}{spanish}"/>'
            f'<xhtml:link rel="alternate" hreflang="en" href="{PUBLIC_SITE_URL}{english}"/>'
            f'<xhtml:link rel="alternate" hreflang="x-default" href="{PUBLIC_SITE_URL}{spanish}"/>'
        )
        entries.append(f"<url><loc>{PUBLIC_SITE_URL}{spanish}</loc>{alternates}</url>")
        entries.append(f"<url><loc>{PUBLIC_SITE_URL}{english}</loc>{alternates}</url>")
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">'
        + "".join(entries)
        + "</urlset>"
    )
    return Response(body, media_type="application/xml")


async def compare(request: Request) -> Response:
    is_english = request.query_params.get("lang") == "en"
    errors = {
        "json": "The request must use JSON.",
        "large": "The request is too large.",
        "length": "The request length is not valid.",
        "valid_json": "The request must contain valid JSON.",
        "object": "The request must be a JSON object.",
        "scenario": "The scenario could not be evaluated with the selected formulas and parameters.",
    } if is_english else {
        "json": "La solicitud debe usar JSON.",
        "large": "La solicitud es demasiado grande.",
        "length": "La longitud de la solicitud no es válida.",
        "valid_json": "La solicitud debe ser JSON válido.",
        "object": "La solicitud debe ser un objeto JSON.",
        "scenario": "El escenario no puede evaluarse con las fórmulas y parámetros seleccionados.",
    }
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return JSONResponse({"error": errors["json"]}, status_code=415)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse({"error": errors["large"]}, status_code=413)
        except ValueError:
            return JSONResponse({"error": errors["length"]}, status_code=400)

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            return JSONResponse({"error": errors["large"]}, status_code=413)
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({"error": errors["valid_json"]}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": errors["object"]}, status_code=400)
    try:
        result = await run_in_threadpool(_service(request).compare, payload)
    except FormulaWebInputError as exc:
        return JSONResponse({"error": errors["scenario"] if is_english else str(exc)}, status_code=422)
    return JSONResponse(result)


def health(_: Request) -> Response:
    return JSONResponse({"status": "ok", "product_version": PRODUCT_VERSION})


def _asset_cache_headers(request: Request) -> dict[str, str]:
    if request.query_params.get("v") == ASSET_VERSION:
        return {"Cache-Control": "public, max-age=31536000, immutable"}
    return {"Cache-Control": "public, max-age=3600"}


def stylesheet(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-public.css",
        media_type="text/css",
        headers=_asset_cache_headers(request),
    )


def script(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-public-analysis.js",
        media_type="text/javascript",
        headers=_asset_cache_headers(request),
    )


def format_script(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-format.js",
        media_type="text/javascript",
        headers=_asset_cache_headers(request),
    )


def lab_script(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-lab.js",
        media_type="text/javascript",
        headers=_asset_cache_headers(request),
    )


def venn_image(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-venn-header.png",
        media_type="image/png",
        headers=_asset_cache_headers(request),
    )


def equations_image(request: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-equations-strip.png",
        media_type="image/png",
        headers=_asset_cache_headers(request),
    )


def http_error(request: Request, exc: HTTPException) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "Recurso no disponible."}, status_code=exc.status_code)
    return PlainTextResponse("No encontrado", status_code=exc.status_code)


def unexpected_error(request: Request, _: Exception) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse(
            {"error": "No se ha podido completar la solicitud."}, status_code=500
        )
    return PlainTextResponse("No se ha podido mostrar la página", status_code=500)


def _allowed_hosts() -> list[str]:
    raw = os.environ.get(
        "FORMULA_PUBLIC_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver"
    )
    hosts = [value.strip() for value in raw.split(",") if value.strip()]
    if not hosts:
        raise ValueError("FORMULA_PUBLIC_ALLOWED_HOSTS cannot be empty")
    return hosts


def create_public_app(
    *,
    service: FormulaPriceComparatorService | None = None,
) -> Starlette:
    app = Starlette(
        debug=False,
        routes=[
            Route("/", root_redirect, methods=["GET"]),
            Route("/formulas", formula_page, methods=["GET"]),
            Route("/formulas/analizador", formula_analysis_page, methods=["GET"]),
            Route("/formulas/laboratorio", formula_lab_page, methods=["GET"]),
            Route("/contacto", contact_redirect, methods=["GET"]),
            Route("/informacion-legal", legal_page, methods=["GET"]),
            Route("/en", root_redirect, methods=["GET"]),
            Route("/en/formulas", formula_page, methods=["GET"]),
            Route("/en/formulas/analyzer", formula_analysis_page, methods=["GET"]),
            Route("/en/formulas/laboratory", formula_lab_page, methods=["GET"]),
            Route("/en/contact", contact_redirect, methods=["GET"]),
            Route("/en/legal", legal_page, methods=["GET"]),
            Route("/api/formula-price-comparator/compare", compare, methods=["POST"]),
            Route("/static/formula-public.css", stylesheet, methods=["GET"]),
            Route("/static/formula-public-analysis.js", script, methods=["GET"]),
            Route("/static/formula-format.js", format_script, methods=["GET"]),
            Route("/static/formula-lab.js", lab_script, methods=["GET"]),
            Route("/static/formula-venn-header.png", venn_image, methods=["GET"]),
            Route("/static/formula-equations-strip.png", equations_image, methods=["GET"]),
            Route("/robots.txt", robots, methods=["GET"]),
            Route("/sitemap.xml", sitemap, methods=["GET"]),
            Route("/health", health, methods=["GET"]),
        ],
        middleware=[
            Middleware(SecurityHeadersMiddleware),
            Middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts()),
        ],
        exception_handlers={HTTPException: http_error, Exception: unexpected_error},
    )
    app.state.formula_service = service or FormulaPriceComparatorService.open(ROOT)
    return app


app = create_public_app()
