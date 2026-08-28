"""Application services: DB-facing use-cases shared by the REST routers and POST /sync.

Errors are `HTTPException` subclasses so routers can let them propagate unchanged, while other
callers (the sync applier) can catch the `ServiceError` family and turn one into a per-op
"rejected" result without importing FastAPI status codes.
"""

from __future__ import annotations

from fastapi import HTTPException


class ServiceError(HTTPException):
    """Base class for domain errors raised by `app.services` and `app.quality_pass`."""

    default_status_code = 400

    def __init__(self, detail: str, status_code: int | None = None) -> None:
        super().__init__(
            status_code=self.default_status_code if status_code is None else status_code,
            detail=detail,
        )


class NotFoundError(ServiceError):
    """Entity missing *or* not visible to this farmer (never reveals which)."""

    default_status_code = 404


class ConflictError(ServiceError):
    """Client-generated id already taken by a different owner / batch."""

    default_status_code = 409


class InvalidRequestError(ServiceError):
    """Well-formed but semantically invalid input (unknown protocol, batch_id mismatch, ...)."""

    default_status_code = 422


__all__ = ["ConflictError", "InvalidRequestError", "NotFoundError", "ServiceError"]
