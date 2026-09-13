"""Internet-facing ASGI app exposing only the formula comparator allowlist."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route
from starlette.templating import Jinja2Templates

from .contact import (
    CONTACT_FORM_MAX_BYTES,
    PROFILE_LABELS,
    PROFILE_OPTIONS,
    REASON_LABELS,
    REASON_OPTIONS,
    ContactDeliveryError,
    ContactDeliveryNotConfigured,
    ContactRateLimiter,
    ContactValidationError,
    ResendContactSender,
    validate_submission,
)
from .public_copy import PUBLIC_COPY
from .service import FormulaPriceComparatorService, FormulaWebInputError, PRODUCT_VERSION


ROOT = Path(__file__).resolve().parents[3]
WEB_DIR = Path(__file__).resolve().parents[1] / "web"
TEMPLATES = Jinja2Templates(directory=str(WEB_DIR / "templates"))
STATIC_DIR = WEB_DIR / "static"
MAX_REQUEST_BYTES = 64 * 1024
ASSET_VERSION = "20260913-public-copy-v1"


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


def _feedback_url(base_url: str, reason: str, origin: str) -> str:
    if not base_url:
        return ""
    parts = urlsplit(base_url)
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key != "motivo"
    ]
    query.append(("motivo", reason))
    if not any(key == "origen" for key, _ in query):
        query.append(("origen", origin))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _page_context(request: Request) -> dict[str, Any]:
    catalog = _service(request).public_catalog()
    feedback_url = str(catalog.get("feedback_url", ""))
    origin = request.url.path
    if request.url.query:
        origin = f"{origin}?{request.url.query}"
    catalog["feedback_urls"] = {
        reason: _feedback_url(feedback_url, reason, origin)
        for reason in ("feedback", "formula", "caso", "analisis")
    }
    for internal_key in ("product_version", "engine_version", "canonical_catalog_version"):
        catalog.pop(internal_key, None)
    catalog["release_label"] = PUBLIC_COPY["common"]["release_label"]
    catalog["editorial"] = {
        "analysis_profiles": PUBLIC_COPY["analysis"]["profiles"],
    }
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
        "copy": PUBLIC_COPY,
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


def _contact_sender_configured(sender: Any) -> bool:
    configured = getattr(sender, "configured", None)
    return bool(configured()) if callable(configured) else True


def _contact_values(request: Request) -> dict[str, str]:
    reason = request.query_params.get("motivo", "feedback")
    if reason not in REASON_LABELS:
        reason = "feedback"
    profile = request.query_params.get("perfil", "administracion")
    if profile not in PROFILE_LABELS:
        profile = "administracion"
    origin = request.query_params.get("origen", "").strip()
    if not origin:
        origin = request.headers.get("referer", "").strip() or "/contacto"
    return {
        "name": "",
        "email": "",
        "profile": profile,
        "reason": reason,
        "message": "",
        "reference_url": "",
        "origin": origin[:500],
    }


def _contact_response(
    request: Request,
    *,
    values: dict[str, str],
    errors: dict[str, str] | None = None,
    form_error: str = "",
    success: bool = False,
    status_code: int = 200,
) -> Response:
    context = _page_context(request)
    context.update(
        {
            "values": values,
            "errors": errors or {},
            "form_error": form_error,
            "success": success,
            "profile_options": PROFILE_OPTIONS,
            "reason_options": REASON_OPTIONS,
            "delivery_configured": _contact_sender_configured(
                request.app.state.contact_sender
            ),
            "release_label": PUBLIC_COPY["common"]["release_label"],
        }
    )
    return TEMPLATES.TemplateResponse(
        request=request,
        name="formula_contact.html",
        context=context,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def contact_page(request: Request) -> Response:
    return _contact_response(request, values=_contact_values(request))


async def _read_contact_fields(request: Request) -> dict[str, str]:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/x-www-form-urlencoded":
        raise ContactValidationError(
            {"form": PUBLIC_COPY["contact"]["validation"]["invalid_format"]}
        )
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            parsed_length = int(content_length)
        except ValueError as exc:
            raise ContactValidationError(
                {"form": PUBLIC_COPY["contact"]["validation"]["invalid_size"]}
            ) from exc
        if parsed_length > CONTACT_FORM_MAX_BYTES:
            raise ContactValidationError(
                {"form": PUBLIC_COPY["contact"]["validation"]["too_large"]}
            )

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > CONTACT_FORM_MAX_BYTES:
            raise ContactValidationError(
                {"form": PUBLIC_COPY["contact"]["validation"]["too_large"]}
            )
    try:
        pairs = parse_qsl(
            body.decode("utf-8"), keep_blank_values=True, max_num_fields=20
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise ContactValidationError(
            {"form": PUBLIC_COPY["contact"]["validation"]["invalid_format"]}
        ) from exc
    allowed = {
        "name",
        "email",
        "profile",
        "reason",
        "message",
        "reference_url",
        "origin",
        "website",
    }
    if any(key not in allowed for key, _ in pairs):
        raise ContactValidationError(
            {"form": PUBLIC_COPY["contact"]["validation"]["invalid_fields"]}
        )
    return dict(pairs)


async def contact_submit(request: Request) -> Response:
    fallback = _contact_values(request)
    try:
        fields = await _read_contact_fields(request)
    except ContactValidationError as exc:
        return _contact_response(
            request,
            values=fallback,
            errors=exc.errors,
            form_error=exc.errors.get(
                "form", PUBLIC_COPY["contact"]["validation"]["review_fields"]
            ),
            status_code=422,
        )

    values = {key: fields.get(key, fallback[key]) for key in fallback}
    if fields.get("website", "").strip():
        return _contact_response(request, values=values, success=True)

    try:
        submission = validate_submission(fields)
    except ContactValidationError as exc:
        return _contact_response(
            request,
            values=values,
            errors=exc.errors,
            form_error=PUBLIC_COPY["contact"]["validation"]["review_fields"],
            status_code=422,
        )

    client_key = request.client.host if request.client else "unknown"
    if not request.app.state.contact_rate_limiter.allow(client_key):
        return _contact_response(
            request,
            values=values,
            form_error=PUBLIC_COPY["contact"]["delivery"]["rate_limited"],
            status_code=429,
        )
    try:
        await run_in_threadpool(request.app.state.contact_sender.send, submission)
    except ContactDeliveryNotConfigured:
        return _contact_response(
            request,
            values=values,
            form_error=PUBLIC_COPY["contact"]["delivery"]["not_configured"],
            status_code=503,
        )
    except ContactDeliveryError:
        return _contact_response(
            request,
            values=values,
            form_error=PUBLIC_COPY["contact"]["delivery"]["failed"],
            status_code=502,
        )
    return _contact_response(request, values=values, success=True)


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
    *,
    service: FormulaPriceComparatorService | None = None,
    contact_sender: Any | None = None,
    contact_rate_limiter: ContactRateLimiter | None = None,
) -> Starlette:
    app = Starlette(
        debug=False,
        routes=[
            Route("/", formula_page, methods=["GET"]),
            Route("/formulas", formula_page, methods=["GET"]),
            Route("/formulas/analizador", formula_analysis_page, methods=["GET"]),
            Route("/formulas/laboratorio", formula_lab_page, methods=["GET"]),
            Route("/contacto", contact_page, methods=["GET"]),
            Route("/contacto", contact_submit, methods=["POST"]),
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
    app.state.contact_sender = (
        contact_sender if contact_sender is not None else ResendContactSender()
    )
    app.state.contact_rate_limiter = (
        contact_rate_limiter
        if contact_rate_limiter is not None
        else ContactRateLimiter()
    )
    return app


app = create_public_app()
