"""Transactional email — a small pluggable provider behind one interface.

Providers (select via PROSPECT_EMAIL_PROVIDER):
  - "console" (default): logs the rendered email and reports success. Zero config, never
    fails — the out-of-the-box default and the automatic fallback when a real provider is
    selected but not fully configured (a bad/incomplete .env degrades to logging instead
    of crashing the caller).
  - "smtp": stdlib smtplib. Configured via SMTP_HOST / SMTP_PORT / SMTP_USER /
    SMTP_PASSWORD / SMTP_FROM / SMTP_USE_TLS (deliberately un-prefixed — the common
    convention for these vars — see config.py).
  - "resend": the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email),
    called with stdlib urllib so no new dependency is needed. Configured via
    PROSPECT_RESEND_API_KEY (+ PROSPECT_EMAIL_FROM for the From: address).

Callers (api/app/alerts_eval.py today; a future signup/auth flow later) build an
EmailMessage — directly, or via one of the render_* template helpers below — and hand it
to a provider's .send(). Providers never raise for an ordinary delivery failure; they log
and return False so a batch caller (the alert evaluator) can keep going with the next
recipient instead of crashing the whole run.
"""
from __future__ import annotations

import html
import json
import logging
import smtplib
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass
from email.message import EmailMessage as _MimeMessage

from .config import settings

logger = logging.getLogger("prospect.email")


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    text_body: str
    html_body: str | None = None


class EmailProvider(ABC):
    name: str = "base"

    @abstractmethod
    def send(self, message: EmailMessage) -> bool:
        """Attempt delivery. Must never raise for an ordinary send failure — log and
        return False so batch callers (the alert evaluator) can continue with the next
        recipient/alert instead of crashing the whole run."""
        raise NotImplementedError


class ConsoleEmailProvider(EmailProvider):
    """Default provider: logs the email and always succeeds. Needs no configuration, so
    the app and `python -m app.alerts_eval` both work out of the box with zero env vars."""

    name = "console"

    def send(self, message: EmailMessage) -> bool:
        logger.info(
            "[console-email] to=%s subject=%r\n--- text body ---\n%s",
            message.to, message.subject, message.text_body,
        )
        return True


class SMTPEmailProvider(EmailProvider):
    name = "smtp"

    def __init__(
        self,
        host: str,
        port: int,
        username: str | None,
        password: str | None,
        from_addr: str,
        use_tls: bool,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.from_addr = from_addr
        self.use_tls = use_tls

    def send(self, message: EmailMessage) -> bool:
        try:
            mime = _MimeMessage()
            mime["Subject"] = message.subject
            mime["From"] = self.from_addr
            mime["To"] = message.to
            mime.set_content(message.text_body)
            if message.html_body:
                mime.add_alternative(message.html_body, subtype="html")
            with smtplib.SMTP(self.host, self.port, timeout=10) as smtp:
                if self.use_tls:
                    smtp.starttls()
                if self.username and self.password:
                    smtp.login(self.username, self.password)
                smtp.send_message(mime)
            return True
        except Exception:
            logger.exception("SMTP send failed to=%s subject=%r", message.to, message.subject)
            return False


class ResendEmailProvider(EmailProvider):
    """Resend HTTP API, called with stdlib urllib — no SDK dependency required."""

    name = "resend"
    _ENDPOINT = "https://api.resend.com/emails"

    def __init__(self, api_key: str, from_addr: str) -> None:
        self.api_key = api_key
        self.from_addr = from_addr

    def send(self, message: EmailMessage) -> bool:
        payload: dict = {
            "from": self.from_addr,
            "to": [message.to],
            "subject": message.subject,
            "text": message.text_body,
        }
        if message.html_body:
            payload["html"] = message.html_body
        req = urllib.request.Request(
            self._ENDPOINT,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if 200 <= resp.status < 300:
                    return True
                logger.error("Resend send failed status=%s to=%s", resp.status, message.to)
                return False
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace") if exc.fp else ""
            logger.error("Resend send failed status=%s to=%s body=%s", exc.code, message.to, body)
            return False
        except Exception:
            logger.exception("Resend send failed to=%s subject=%r", message.to, message.subject)
            return False


def get_email_provider() -> EmailProvider:
    """Build the provider selected by PROSPECT_EMAIL_PROVIDER. Falls back to console (with
    a warning) if the selected provider is missing required config, so a bad/incomplete
    .env degrades to logging instead of crashing the caller."""
    provider = (settings.email_provider or "console").strip().lower()

    if provider == "smtp":
        if settings.smtp_host:
            return SMTPEmailProvider(
                host=settings.smtp_host,
                port=settings.smtp_port,
                username=settings.smtp_user,
                password=settings.smtp_password,
                from_addr=settings.smtp_from or settings.email_from,
                use_tls=settings.smtp_use_tls,
            )
        logger.warning(
            "PROSPECT_EMAIL_PROVIDER=smtp but SMTP_HOST is not set; falling back to console."
        )
        return ConsoleEmailProvider()

    if provider == "resend":
        if settings.resend_api_key:
            return ResendEmailProvider(api_key=settings.resend_api_key, from_addr=settings.email_from)
        logger.warning(
            "PROSPECT_EMAIL_PROVIDER=resend but PROSPECT_RESEND_API_KEY is not set; "
            "falling back to console."
        )
        return ConsoleEmailProvider()

    if provider != "console":
        logger.warning(
            "Unknown PROSPECT_EMAIL_PROVIDER=%r; falling back to console.", settings.email_provider
        )
    return ConsoleEmailProvider()


# ---- templates -------------------------------------------------------------------------
# Hand-rolled string templates (no Jinja dependency needed at this size — keeps
# requirements.txt untouched). All user/data-controlled strings are html-escaped before
# going into the HTML body.

_WRAPPER_HTML = """\
<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; \
margin: 0 auto; color: #1a1a1a;">
  <h2 style="margin-bottom: 4px;">{heading}</h2>
  {body}
  <hr style="margin-top: 24px; border: none; border-top: 1px solid #ddd;" />
  <p style="font-size: 12px; color: #888;">Prospect &mdash; Steam market intelligence</p>
</div>
"""


def render_welcome(org_name: str) -> tuple[str, str, str]:
    """Welcome email for a brand-new org. Not wired to a signup flow yet — auth is still a
    stub (see config.py's solo_mode) — but ready for that flow to call once accounts exist.
    Returns (subject, text_body, html_body)."""
    safe_name = html.escape(org_name)
    subject = "Welcome to Prospect"
    text_body = (
        f"Welcome to Prospect, {org_name}!\n\n"
        "Your workspace is ready. Head to the Niche Finder to start exploring the market, "
        "and set up alerts so we tell you when something changes instead of you having to "
        "go check.\n"
    )
    html_body = _WRAPPER_HTML.format(
        heading=f"Welcome to Prospect, {safe_name}!",
        body=(
            "<p>Your workspace is ready. Head to the Niche Finder to start exploring the "
            "market, and set up alerts so we tell you when something changes instead of you "
            "having to go check.</p>"
        ),
    )
    return subject, text_body, html_body


@dataclass(frozen=True)
class AlertDigestItem:
    headline: str
    detail: str = ""
    url: str | None = None


def render_alert_digest(org_name: str, items: list[AlertDigestItem]) -> tuple[str, str, str]:
    """Per-org digest of everything api/app/alerts_eval.py matched on a run. Returns
    (subject, text_body, html_body)."""
    n = len(items)
    subject = f"Prospect: {n} alert{'s' if n != 1 else ''} triggered"
    base_url = settings.app_base_url.rstrip("/")

    text_lines = [f"Hi {org_name},", "", f"{n} of your alerts matched on this run:", ""]
    html_items = []
    for item in items:
        line = f"- {item.headline}"
        if item.detail:
            line += f" ({item.detail})"
        if item.url:
            line += f" -> {base_url}{item.url}"
        text_lines.append(line)

        safe_headline = html.escape(item.headline)
        li = f"<li><strong>{safe_headline}</strong>"
        if item.detail:
            li += f" &mdash; {html.escape(item.detail)}"
        if item.url:
            safe_url = html.escape(f"{base_url}{item.url}")
            li += f' &mdash; <a href="{safe_url}">view</a>'
        li += "</li>"
        html_items.append(li)

    text_lines += ["", f"View them live: {settings.app_base_url}"]
    text_body = "\n".join(text_lines)
    html_body = _WRAPPER_HTML.format(
        heading=f"{n} alert{'s' if n != 1 else ''} triggered",
        body=f"<ul>{''.join(html_items)}</ul>",
    )
    return subject, text_body, html_body
