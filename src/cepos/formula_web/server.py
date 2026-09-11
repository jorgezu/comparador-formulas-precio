"""Production launcher for the isolated public comparator."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "cepos.formula_web.public_app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=True,
    )


if __name__ == "__main__":
    main()
