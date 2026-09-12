"""Internet-facing ASGI app exposing only the formula comparator allowlist."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route
from starlette.templating import Jinja2Templates

from .service import FormulaPriceComparatorService, FormulaWebInputError, PRODUCT_VERSION


ROOT = Path(__file__).resolve().parents[3]
WEB_DIR = Path(__file__).resolve().parents[1] / "web"
TEMPLATES = Jinja2Templates(directory=str(WEB_DIR / "templates"))
STATIC_DIR = WEB_DIR / "static"
MAX_REQUEST_BYTES = 64 * 1024
ASSET_VERSION = "20260912-cockpit-v1-1"


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
                        (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
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


def _page_context(request: Request) -> dict[str, Any]:
    catalog = _service(request).public_catalog()
    catalog["api_url"] = "/api/formula-price-comparator/compare"
    catalog["home_url"] = "/formulas"
    catalog["analyzer_url"] = "/formulas/analizador"
    catalog["lab_url"] = "/formulas/laboratorio"
    return {
        "request": request,
        "catalog": catalog,
        "home_url": catalog["home_url"],
        "analyzer_url": catalog["analyzer_url"],
        "lab_url": catalog["lab_url"],
        "stylesheet_url": f"/static/formula-public.css?v={ASSET_VERSION}",
        "format_script_url": f"/static/formula-format.js?v={ASSET_VERSION}",
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
    context["script_url"] = f"/static/formula-public-analysis.js?v={ASSET_VERSION}"
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


async def compare(request: Request) -> Response:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return JSONResponse({"error": "La solicitud debe usar JSON."}, status_code=415)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse({"error": "La solicitud es demasiado grande."}, status_code=413)
        except ValueError:
            return JSONResponse({"error": "La longitud de la solicitud no es válida."}, status_code=400)

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            return JSONResponse({"error": "La solicitud es demasiado grande."}, status_code=413)
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({"error": "La solicitud debe ser JSON válido."}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "La solicitud debe ser un objeto JSON."}, status_code=400)
    try:
        result = await run_in_threadpool(_service(request).compare, payload)
    except FormulaWebInputError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    return JSONResponse(result)


def health(_: Request) -> Response:
    return JSONResponse({"status": "ok", "product_version": PRODUCT_VERSION})


def stylesheet(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-public.css",
        media_type="text/css",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def script(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-public-analysis.js",
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def format_script(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-format.js",
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def lab_script(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-lab.js",
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def venn_image(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-venn-header.png",
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def equations_image(_: Request) -> Response:
    return FileResponse(
        STATIC_DIR / "formula-equations-strip.png",
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
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
    *, service: FormulaPriceComparatorService | None = None
) -> Starlette:
    app = Starlette(
        debug=False,
        routes=[
            Route("/", formula_page, methods=["GET"]),
            Route("/formulas", formula_page, methods=["GET"]),
            Route("/formulas/analizador", formula_analysis_page, methods=["GET"]),
            Route("/formulas/laboratorio", formula_lab_page, methods=["GET"]),
            Route("/api/formula-price-comparator/compare", compare, methods=["POST"]),
            Route("/static/formula-public.css", stylesheet, methods=["GET"]),
            Route("/static/formula-public-analysis.js", script, methods=["GET"]),
            Route("/static/formula-format.js", format_script, methods=["GET"]),
            Route("/static/formula-lab.js", lab_script, methods=["GET"]),
            Route("/static/formula-venn-header.png", venn_image, methods=["GET"]),
            Route("/static/formula-equations-strip.png", equations_image, methods=["GET"]),
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
