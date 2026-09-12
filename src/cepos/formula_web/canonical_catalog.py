"""Validated public terminology and equations for the formula experience."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


REQUIRED_METHOD_KEYS = {
    "method_id",
    "public_name",
    "short_name",
    "implementation_expression",
    "equation_plain",
    "equation_mathml",
    "reference_type",
    "dependency",
    "parameters",
    "description",
    "behavior",
    "particularities",
    "zero_discount_behavior",
    "verified_equivalences",
    "source_alignment",
    "discrepancies",
}


class PublicFormulaCanonicalCatalog:
    """Load the reviewed names and equations without private source references."""

    def __init__(self, artifact_path: Path) -> None:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        if artifact.get("schema_version") != "FORMULA_CANONICAL_CATALOG_V1":
            raise ValueError("Unsupported canonical formula catalog")
        raw_methods = artifact.get("methods")
        if not isinstance(raw_methods, list) or not raw_methods:
            raise ValueError("Canonical formula catalog is empty")
        self._methods: dict[str, dict[str, Any]] = {}
        for raw in raw_methods:
            method = self._validate_method(raw)
            method_id = method["method_id"]
            if method_id in self._methods:
                raise ValueError("Duplicate method in canonical formula catalog")
            self._methods[method_id] = method

    @staticmethod
    def _validate_method(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or set(raw) != REQUIRED_METHOD_KEYS:
            raise ValueError("Invalid canonical formula fields")
        method = dict(raw)
        for key in (
            "method_id",
            "public_name",
            "short_name",
            "implementation_expression",
            "equation_plain",
            "equation_mathml",
            "reference_type",
            "dependency",
            "description",
            "behavior",
            "zero_discount_behavior",
        ):
            if not isinstance(method[key], str) or not method[key].strip():
                raise ValueError(f"Invalid canonical formula value: {key}")
        if method["reference_type"] not in {"Relativa", "Absoluta", "Mixta"}:
            raise ValueError("Invalid canonical reference type")
        for key in (
            "parameters",
            "particularities",
            "verified_equivalences",
            "source_alignment",
            "discrepancies",
        ):
            if not isinstance(method[key], list) or any(
                not isinstance(value, str) for value in method[key]
            ):
                raise ValueError(f"Invalid canonical formula list: {key}")
        if "<math" not in method["equation_mathml"]:
            raise ValueError("Canonical equation must include MathML")
        return method

    def methods(self) -> dict[str, dict[str, Any]]:
        return json.loads(json.dumps(self._methods, ensure_ascii=False))
