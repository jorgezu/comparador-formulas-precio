"""Validated, non-persistent contact delivery for the public formula app."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parseaddr
import json
import os
import re
from threading import Lock
import time
from typing import Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from .public_copy import PUBLIC_COPY


CONTACT_FORM_MAX_BYTES = 16 * 1024
RESEND_ENDPOINT = "https://api.resend.com/emails"
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CONTACT_COPY = PUBLIC_COPY["contact"]

PROFILE_OPTIONS = tuple(CONTACT_COPY["profiles"])
REASON_OPTIONS = tuple(CONTACT_COPY["reasons"])

PROFILE_LABELS = dict(PROFILE_OPTIONS)
REASON_LABELS = dict(REASON_OPTIONS)


class ContactValidationError(ValueError):
    def __init__(self, errors: Mapping[str, str]) -> None:
        super().__init__(CONTACT_COPY["validation"]["form_contains_errors"])
        self.errors = dict(errors)


class ContactDeliveryError(RuntimeError):
    pass


class ContactDeliveryNotConfigured(ContactDeliveryError):
    pass


@dataclass(frozen=True)
class ContactSubmission:
    name: str
    email: str
    profile: str
    reason: str
    message: str
    reference_url: str
    origin: str
    submitted_at: datetime

    @property
    def profile_label(self) -> str:
        return PROFILE_LABELS[self.profile]

    @property
    def reason_label(self) -> str:
        return REASON_LABELS[self.reason]


def _clean_text(value: str, maximum: int) -> str:
    cleaned = value.strip()
    if len(cleaned) > maximum or any(character in cleaned for character in ("\x00", "\r")):
        raise ValueError
    return cleaned


def _valid_email(value: str) -> bool:
    if not value or len(value) > 254 or not EMAIL_PATTERN.fullmatch(value):
        return False
    return parseaddr(value)[1] == value


def _valid_reference_url(value: str) -> bool:
    if not value:
        return True
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (
        len(value) <= 2_000
        and parsed.scheme in {"http", "https"}
        and bool(parsed.netloc and parsed.hostname)
        and parsed.username is None
        and parsed.password is None
    )


def validate_submission(
    fields: Mapping[str, str],
    *,
    now: Callable[[], datetime] | None = None,
) -> ContactSubmission:
    errors: dict[str, str] = {}
    try:
        name = _clean_text(fields.get("name", ""), 100)
    except ValueError:
        name = ""
        errors["name"] = CONTACT_COPY["validation"]["name_too_long"]

    try:
        email = _clean_text(fields.get("email", ""), 254)
    except ValueError:
        email = ""
        errors["email"] = CONTACT_COPY["validation"]["invalid_email"]
    if email and not _valid_email(email):
        errors["email"] = CONTACT_COPY["validation"]["invalid_email"]

    profile = fields.get("profile", "")
    if profile not in PROFILE_LABELS:
        errors["profile"] = CONTACT_COPY["validation"]["invalid_profile"]

    reason = fields.get("reason", "")
    if reason not in REASON_LABELS:
        errors["reason"] = CONTACT_COPY["validation"]["invalid_reason"]

    try:
        message = _clean_text(fields.get("message", ""), 5_000)
    except ValueError:
        message = ""
        errors["message"] = CONTACT_COPY["validation"]["message_too_long"]
    if not message:
        errors["message"] = CONTACT_COPY["validation"]["message_required"]

    try:
        reference_url = _clean_text(fields.get("reference_url", ""), 2_000)
    except ValueError:
        reference_url = ""
        errors["reference_url"] = CONTACT_COPY["validation"]["invalid_reference"]
    if reference_url and not _valid_reference_url(reference_url):
        errors["reference_url"] = CONTACT_COPY["validation"]["invalid_reference_url"]

    try:
        origin = _clean_text(fields.get("origin", "/contacto"), 500) or "/contacto"
    except ValueError:
        origin = "/contacto"

    if errors:
        raise ContactValidationError(errors)
    current_time = (now or (lambda: datetime.now(timezone.utc)))()
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    return ContactSubmission(
        name=name,
        email=email,
        profile=profile,
        reason=reason,
        message=message,
        reference_url=reference_url,
        origin=origin,
        submitted_at=current_time,
    )


class ContactRateLimiter:
    """Small in-memory limiter; entries expire and no message content is retained."""

    def __init__(
        self,
        *,
        limit: int = 5,
        window_seconds: int = 15 * 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, client_key: str) -> bool:
        now = self.clock()
        threshold = now - self.window_seconds
        with self._lock:
            events = self._events[client_key]
            while events and events[0] <= threshold:
                events.popleft()
            if len(events) >= self.limit:
                return False
            events.append(now)
            return True


class ResendContactSender:
    """Send plain-text contact messages using environment-only Resend settings."""

    @staticmethod
    def configured() -> bool:
        return all(
            os.environ.get(name, "").strip()
            for name in (
                "RESEND_API_KEY",
                "FORMULA_FEEDBACK_EMAIL",
                "FORMULA_FEEDBACK_FROM",
            )
        )

    def send(self, submission: ContactSubmission) -> str:
        api_key = os.environ.get("RESEND_API_KEY", "").strip()
        recipient = os.environ.get("FORMULA_FEEDBACK_EMAIL", "").strip()
        sender = os.environ.get("FORMULA_FEEDBACK_FROM", "").strip()
        if not api_key or not recipient or not sender:
            raise ContactDeliveryNotConfigured("Contact delivery is not configured")

        email_copy = CONTACT_COPY["email"]
        lines = [
            f"{email_copy['name']}: {submission.name or email_copy['not_provided']}",
            f"{email_copy['email']}: {submission.email or email_copy['not_provided']}",
            f"{email_copy['profile']}: {submission.profile_label}",
            f"{email_copy['reason']}: {submission.reason_label}",
            "",
            email_copy["message"],
            submission.message,
        ]
        if submission.reference_url:
            lines.extend(("", f"{email_copy['reference']}: {submission.reference_url}"))
        lines.extend(
            (
                "",
                f"{email_copy['origin']}: {submission.origin}",
                f"{email_copy['submitted_at']}: {submission.submitted_at.astimezone(timezone.utc).isoformat()}",
            )
        )
        payload: dict[str, object] = {
            "from": sender,
            "to": [recipient],
            "subject": f"{email_copy['subject_prefix']} {submission.reason_label} · {submission.profile_label}",
            "text": "\n".join(lines),
        }
        if submission.email:
            payload["reply_to"] = submission.email

        request = Request(
            RESEND_ENDPOINT,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "TenderLab-Contact/1.0",
                "Idempotency-Key": f"tenderlab-contact-{uuid4().hex}",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=10) as response:
                if not 200 <= response.status < 300:
                    raise ContactDeliveryError("Resend rejected the message")
                result = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ContactDeliveryError("Resend delivery failed") from exc
        if not isinstance(result, dict):
            raise ContactDeliveryError("Resend returned an invalid response")
        return str(result.get("id", ""))
