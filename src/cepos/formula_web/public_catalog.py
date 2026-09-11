"""Load the sanitized, deployable derivative of the internal formula catalog."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from cepos.formula_simulation import MethodDefinition


class PublicFormulaMethodCatalog:
    """Minimal catalog with no workbook, path, cell, or document provenance."""

    def __init__(self, artifact_path: Path) -> None:
        self.artifact_path = artifact_path.resolve()
        artifact = json.loads(self.artifact_path.read_text(encoding="utf-8"))
        if artifact.get("schema_version") != "formula_public_catalog_v1":
            raise ValueError("Unsupported public formula catalog")
        self.product_version = str(artifact.get("product_version", ""))
        self.engine_version = str(artifact.get("engine_version", ""))
        self.source_artifact_sha256 = str(artifact.get("source_artifact_sha256", ""))
        self._methods: dict[str, MethodDefinition] = {}
        self._variants: dict[str, tuple[MethodDefinition, ...]] = {}
        for raw in artifact.get("methods", ()):
            base = self._definition(raw, raw.get("parameters", {}))
            method_id = base.method_id
            if method_id in self._methods:
                raise ValueError("Duplicate method in public formula catalog")
            self._methods[method_id] = base
            self._variants[method_id] = tuple(
                self._definition(raw, variant.get("parameters", {}))
                for variant in raw.get("variants", ())
            ) or (base,)

    @staticmethod
    def _definition(raw: Mapping[str, Any], parameters: Mapping[str, Any]) -> MethodDefinition:
        return MethodDefinition(
            method_id=str(raw["method_id"]),
            method_signature=str(raw["method_signature"]),
            display_name=str(raw["display_name"]),
            expression=str(raw["expression"]),
            parameters={str(key): float(value) for key, value in parameters.items()},
            parameter_origin="DOCUMENTED",
            set_dependencies=tuple(str(value) for value in raw.get("set_dependencies", ())),
            curvature=str(raw["curvature"]),
            sources=(),
        )

    def confirmed_methods(self) -> tuple[MethodDefinition, ...]:
        return tuple(self._methods.values())

    def variants(self, method_id: str) -> tuple[MethodDefinition, ...]:
        return self._variants[method_id]
