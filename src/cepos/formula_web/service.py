"""Sanitized product API backed by CePOS' validated formula engines."""

from __future__ import annotations

from dataclasses import replace
import json
import math
import os
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from cepos.formula_simulation import (
    FormulaComparisonEngine,
    FormulaSimulationEngine,
    MethodDefinition,
    Scenario,
    SIMULATION_VERSION,
)

from .canonical_catalog import PublicFormulaCanonicalCatalog
from .public_catalog import PublicFormulaMethodCatalog
from .public_cases import PublicFormulaCaseCatalog


PRODUCT_VERSION = "FORMULA_WEB_PUBLIC_BETA_V1"
PRODUCT_CONFIG_PATH = Path("config/public_tools/formula_price_comparator_v1.json")
PUBLIC_CATALOG_PATH = Path(__file__).resolve().parent / "artifacts/formula_public_catalog_v1.json"
PUBLIC_CASES_PATH = Path(__file__).resolve().parent / "artifacts/formula_public_cases_v2.json"
CANONICAL_CATALOG_PATH = (
    Path(__file__).resolve().parent / "artifacts/formula_canonical_catalog_v1.json"
)

THEORETICAL_BMAX_DEFAULTS = {
    "OBRAS": 15.0,
    "SUMINISTROS": 30.0,
    "SERVICIOS": 40.0,
}
CURVE_POINT_COUNT = 101


PUBLIC_METHODS: dict[str, dict[str, Any]] = {
    "INVERSE_PRICE_PROPORTIONAL": {
        "name": "Proporcional inversa al precio",
        "short_name": "Inversa",
        "description": (
            "La oferta de menor precio obtiene la puntuación máxima. El resto recibe "
            "una puntuación inversamente proporcional a su precio."
        ),
        "dependency": "Oferta mínima",
        "behavior": "No lineal, convexa respecto de la baja",
        "reference_type": "Relativa",
    },
    "LINEAR_DISCOUNT_MAX": {
        "name": "Lineal respecto de la baja máxima",
        "short_name": "Lineal Bmax",
        "description": (
            "Reparte la puntuación de forma lineal según la baja y toma como referencia "
            "la mayor baja del conjunto."
        ),
        "dependency": "Baja máxima",
        "behavior": "Lineal",
        "reference_type": "Relativa",
    },
    "AFFINE_MIN_REFERENCE_OVER_TENDER_PRICE": {
        "name": "Lineal referenciada a la oferta mínima",
        "short_name": "Afín Omin",
        "description": (
            "Resta puntuación según la distancia a la oferta mínima, usando el presupuesto "
            "de licitación como escala."
        ),
        "dependency": "Oferta mínima",
        "behavior": "Lineal",
        "reference_type": "Relativa",
    },
    "NORMALIZED_PRICE_GAP_POWER": {
        "name": "Brecha normalizada potencial",
        "short_name": "Brecha potencial",
        "description": (
            "Compara cada precio con la oferta mínima y aplica un exponente a esa distancia "
            "normalizada. El exponente cambia cuánto se concentran las puntuaciones."
        ),
        "dependency": "Oferta mínima",
        "behavior": "Paramétrico; cóncavo respecto de la baja cuando n > 1",
        "reference_type": "Relativa",
    },
    "DISCOUNT_MAX_POWER": {
        "name": "Potencia sobre la baja máxima",
        "short_name": "Potencia Bmax",
        "description": (
            "Compara cada baja con la baja máxima y aplica una potencia. La variante "
            "documentada de raíz sexta eleva con rapidez las puntuaciones iniciales."
        ),
        "dependency": "Baja máxima",
        "behavior": "Potencial, cóncavo con la raíz sexta documentada",
        "reference_type": "Relativa",
    },
    "EXPONENTIAL_SATURATING_DISCOUNT": {
        "name": "Exponencial saturante",
        "short_name": "Exponencial",
        "description": (
            "La puntuación crece con la baja y se aproxima progresivamente al máximo. "
            "No cambia por la entrada de otras ofertas."
        ),
        "dependency": "No; usa cada oferta y parámetros fijos",
        "behavior": "No lineal, cóncava y saturante",
        "reference_type": "Absoluta",
    },
    "DISCOUNT_THRESHOLD_TWO_SEGMENTS": {
        "name": "Lineal por tramos",
        "short_name": "Dos tramos",
        "description": (
            "Aplica una pendiente hasta un umbral de baja y reparte después los puntos "
            "del tramo final hasta la baja máxima."
        ),
        "dependency": "Baja máxima",
        "behavior": "Lineal por tramos",
        "reference_type": "Mixta",
    },
}


PARAMETER_FIELDS: dict[str, tuple[dict[str, Any], ...]] = {
    "NORMALIZED_PRICE_GAP_POWER": (
        {"name": "n", "label": "Exponente n", "min": 0.01, "max": 100.0, "step": 0.01},
    ),
    "DISCOUNT_MAX_POWER": (
        {"name": "k", "label": "Índice de la raíz k", "min": 0.01, "max": 100.0, "step": 0.01},
    ),
    "EXPONENTIAL_SATURATING_DISCOUNT": (
        {"name": "k", "label": "Coeficiente k", "min": 0.001, "max": 10.0, "step": 0.001},
    ),
    "DISCOUNT_THRESHOLD_TWO_SEGMENTS": (
        {"name": "n", "label": "Pendiente inicial n", "min": 0.01, "max": 100.0, "step": 0.01},
        {
            "name": "B",
            "label": "Umbral de baja B",
            "suffix": "%",
            "min": 0.01,
            "max": 99.99,
            "step": 0.01,
        },
        {"name": "k", "label": "Puntos del tramo final k", "min": 0.01, "max": 100.0, "step": 0.01},
    ),
}


class FormulaWebInputError(ValueError):
    """Expected validation error for a public comparator request."""


class FormulaPriceComparatorService:
    """Product-facing adapter that never exposes documentary traceability."""

    def __init__(
        self,
        root: Path,
        catalog: PublicFormulaMethodCatalog,
        config: Mapping[str, Any],
    ) -> None:
        self.root = root.resolve()
        self.config = dict(config)
        self.catalog = catalog
        self.case_catalog = PublicFormulaCaseCatalog(PUBLIC_CASES_PATH)
        canonical = PublicFormulaCanonicalCatalog(CANONICAL_CATALOG_PATH).methods()
        self.simulation_engine = FormulaSimulationEngine()
        self.comparison_engine = FormulaComparisonEngine(self.simulation_engine)
        self.methods = {item.method_id: item for item in self.catalog.confirmed_methods()}
        if set(self.methods) != set(PUBLIC_METHODS) or set(self.methods) != set(canonical):
            raise ValueError("The public formula catalog does not match the seven confirmed methods")
        for method_id, method in self.methods.items():
            if canonical[method_id]["implementation_expression"] != method.expression:
                raise ValueError(
                    f"Canonical equation differs from validated method: {method_id}"
                )
        self.public_methods = {
            method_id: {
                **PUBLIC_METHODS[method_id],
                **canonical[method_id],
                "name": canonical[method_id]["public_name"],
            }
            for method_id in self.methods
        }
        self.variant_definitions = {
            method_id: self._build_variants(method)
            for method_id, method in self.methods.items()
        }

    @classmethod
    def open(cls, root: Path | str | None = None) -> "FormulaPriceComparatorService":
        workspace = Path(root).resolve() if root is not None else Path(__file__).resolve().parents[3]
        config = json.loads((workspace / PRODUCT_CONFIG_PATH).read_text(encoding="utf-8"))
        if config.get("schema_version") != "formula_price_comparator_config_v1":
            raise ValueError("Unsupported formula comparator configuration")
        if config.get("product_version") != PRODUCT_VERSION:
            raise ValueError("Unsupported formula comparator product version")
        catalog = PublicFormulaMethodCatalog(PUBLIC_CATALOG_PATH)
        if catalog.product_version != PRODUCT_VERSION:
            raise ValueError("Unsupported public formula catalog product version")
        if catalog.engine_version != SIMULATION_VERSION:
            raise ValueError("Unsupported formula simulation contract")
        return cls(workspace, catalog, config)

    def public_catalog(self) -> dict[str, Any]:
        default_methods = set(self.config.get("default_methods", ()))
        methods = []
        for method_id, method in self.methods.items():
            public = self.public_methods[method_id]
            variants = self.variant_definitions[method_id]
            default_variant_id = next(
                variant_id
                for variant_id, definition in variants
                if self._same_parameters(definition.parameters, method.parameters)
            )
            methods.append(
                {
                    "method_id": method_id,
                    "name": public["name"],
                    "short_name": public["short_name"],
                    "description": public["description"],
                    "expression": method.expression,
                    "equation_plain": public["equation_plain"],
                    "equation_mathml": public["equation_mathml"],
                    "equation_offers_plain": public["equation_offers_plain"],
                    "equation_offers_mathml": public["equation_offers_mathml"],
                    "equation_discounts_plain": public["equation_discounts_plain"],
                    "equation_discounts_mathml": public["equation_discounts_mathml"],
                    "family": public["family"],
                    "equivalence_group": public["equivalence_group"],
                    "special_cases": list(public["special_cases"]),
                    "depends_on_other_offers": bool(method.set_dependencies),
                    "dependency": public["dependency"],
                    "behavior": public["behavior"],
                    "reference_type": public["reference_type"],
                    "particularities": list(public["particularities"]),
                    "zero_discount_behavior": public["zero_discount_behavior"],
                    "verified_equivalences": list(public["verified_equivalences"]),
                    "source_alignment": list(public["source_alignment"]),
                    "discrepancies": list(public["discrepancies"]),
                    "default_selected": method_id in default_methods,
                    "default_variant_id": default_variant_id,
                    "variants": [
                        {
                            "variant_id": variant_id,
                            "label": self._variant_label(method_id, definition.parameters),
                            "origin": "DOCUMENTED",
                            "parameters": self._public_parameters(
                                method_id, definition.parameters
                            ),
                            "dynamic": False,
                        }
                        for variant_id, definition in variants
                    ] + (
                        [
                            {
                                "variant_id": "bmax-over-5",
                                "label": "n = Bmax / 5 · autoajustada",
                                "origin": "BMAX_DERIVED",
                                "parameters": {},
                                "dynamic": True,
                            }
                        ]
                        if method_id == "NORMALIZED_PRICE_GAP_POWER"
                        else []
                    ),
                    "parameter_fields": [dict(item) for item in PARAMETER_FIELDS.get(method_id, ())],
                }
            )
        return {
            "product_version": PRODUCT_VERSION,
            "engine_version": SIMULATION_VERSION,
            "canonical_catalog_version": "FORMULA_CANONICAL_CATALOG_V2",
            "title": str(self.config["title"]),
            "feedback_url": self._feedback_url(),
            "author": {
                "name": str(self.config.get("author", {}).get("name", "Jorge Cejudo Podio")),
                "linkedin_url": self._configured_url(
                    "FORMULA_LINKEDIN_URL", "linkedin_url", section="author"
                ),
                "website_url": self._configured_url(
                    "FORMULA_WEBSITE_URL", "website_url", section="author"
                ),
            },
            "max_offers": int(self.config.get("max_offers", 20)),
            "theoretical_bmax_defaults": dict(THEORETICAL_BMAX_DEFAULTS),
            "demo": self.config["demo"],
            "cases": self._public_cases(),
            "methods": methods,
        }

    def compare(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise FormulaWebInputError("La solicitud debe ser un objeto JSON.")
        self._reject_unknown_keys(
            payload,
            {
                "tender_price",
                "pmax",
                "offers",
                "methods",
                "baseline",
                "expected_maximum_discount_pct",
            },
            "La solicitud contiene campos no admitidos.",
        )
        scenario, offer_names = self._scenario(
            {key: payload[key] for key in ("tender_price", "pmax", "offers") if key in payload},
            "CURRENT",
        )
        expected_bmax_pct = self._expected_bmax(
            payload.get("expected_maximum_discount_pct", 30.0)
        )
        observed_bmax_pct = max(
            (scenario.tender_price - value) / scenario.tender_price * 100.0
            for value in scenario.offers
        )
        selected = self._selected_methods(
            payload.get("methods"), observed_bmax_pct=observed_bmax_pct
        )
        comparison = self.comparison_engine.compare(
            tuple(definition for _, definition, _ in selected), scenario
        )
        if comparison.errors:
            raise FormulaWebInputError(self._public_engine_error(comparison.errors[0]))

        metrics = {str(item["method_id"]): item for item in comparison.metrics}
        simulations = {item.method_id: item for item in comparison.simulations}
        public_methods = [
            self._public_result(method_id, definition, variant, simulations[method_id], metrics[method_id])
            for method_id, definition, variant in selected
        ]
        visual_bmax_pct = self._visual_bmax(expected_bmax_pct, observed_bmax_pct)
        public_methods = [
            self._with_curve_role(method) for method in public_methods
        ]
        rows = self._table_rows(scenario, offer_names, public_methods)
        self._add_theoretical_scores(rows, scenario, selected, expected_bmax_pct)
        result = {
            "product_version": PRODUCT_VERSION,
            "engine_version": SIMULATION_VERSION,
            "scenario": {
                "tender_price": scenario.tender_price,
                "pmax": scenario.pmax,
                "offer_count": len(scenario.offers),
                "minimum_offer": min(scenario.offers),
                "maximum_discount_pct": observed_bmax_pct,
                "expected_maximum_discount_pct": expected_bmax_pct,
                "bmax_difference_pp": observed_bmax_pct - expected_bmax_pct,
                "visual_maximum_discount_pct": visual_bmax_pct,
            },
            "methods": public_methods,
            "rows": rows,
            "curves": self._curves(
                scenario,
                selected,
                expected_bmax_pct=expected_bmax_pct,
                observed_bmax_pct=observed_bmax_pct,
                visual_bmax_pct=visual_bmax_pct,
            ),
            "variant_comparisons": self._variant_comparisons(
                scenario, selected, expected_bmax_pct
            ),
            "impacts": [],
            "change_context": None,
        }

        baseline_payload = payload.get("baseline")
        if baseline_payload is not None and not isinstance(baseline_payload, Mapping):
            raise FormulaWebInputError("La situación de referencia no es válida.")
        if isinstance(baseline_payload, Mapping):
            baseline, _ = self._scenario(baseline_payload, "BASELINE")
            result["impacts"] = self._impacts(baseline, scenario, selected)
            result["change_context"] = self._change_context(baseline, scenario)
        return result

    def _build_variants(self, method: MethodDefinition) -> tuple[tuple[str, MethodDefinition], ...]:
        definitions = list(self.catalog.variants(method.method_id))
        definitions.sort(key=lambda item: tuple(sorted(item.parameters.items())))
        if not any(self._same_parameters(item.parameters, method.parameters) for item in definitions):
            definitions.append(method)
        if not definitions:
            definitions = [method]
        return tuple(
            (f"documented-{index}", definition)
            for index, definition in enumerate(definitions, start=1)
        )

    def _selected_methods(
        self, raw_selections: Any, *, observed_bmax_pct: float | None = None
    ) -> tuple[tuple[str, MethodDefinition, dict[str, Any]], ...]:
        if not isinstance(raw_selections, list) or not raw_selections:
            raise FormulaWebInputError("Selecciona al menos una fórmula.")
        if len(raw_selections) > len(self.methods):
            raise FormulaWebInputError("Se han seleccionado demasiadas fórmulas.")
        selected = []
        seen = set()
        for raw in raw_selections:
            if not isinstance(raw, Mapping):
                raise FormulaWebInputError("La selección de fórmulas no es válida.")
            self._reject_unknown_keys(
                raw,
                {"method_id", "variant_id", "parameters"},
                "La selección de fórmulas contiene campos no admitidos.",
            )
            method_id = raw.get("method_id")
            if not isinstance(method_id, str):
                raise FormulaWebInputError("La fórmula seleccionada no es válida.")
            if method_id not in self.methods or method_id in seen:
                raise FormulaWebInputError("La selección contiene una fórmula no disponible o repetida.")
            seen.add(method_id)
            variant_id = raw.get("variant_id")
            if not isinstance(variant_id, str):
                raise FormulaWebInputError("La variante seleccionada no es válida.")
            options = dict(self.variant_definitions[method_id])
            if (
                method_id == "NORMALIZED_PRICE_GAP_POWER"
                and variant_id == "bmax-over-5"
            ):
                if "parameters" in raw:
                    raise FormulaWebInputError(
                        "La variante autoajustada no admite parámetros libres."
                    )
                if observed_bmax_pct is None:
                    raise FormulaWebInputError(
                        "La variante autoajustada necesita una Bmax observada."
                    )
                definition = replace(
                    self.methods[method_id],
                    parameters={"n": observed_bmax_pct / 5.0},
                    parameter_origin="BMAX_DERIVED",
                    sources=(),
                )
                variant = {"variant_id": variant_id, "origin": "BMAX_DERIVED"}
            elif variant_id == "custom":
                fields = PARAMETER_FIELDS.get(method_id, ())
                if not fields:
                    raise FormulaWebInputError("Esta fórmula no admite parámetros libres.")
                raw_parameters = raw.get("parameters")
                if not isinstance(raw_parameters, Mapping):
                    raise FormulaWebInputError("Introduce todos los parámetros personalizados.")
                allowed_parameters = {str(field["name"]) for field in fields}
                self._reject_unknown_keys(
                    raw_parameters,
                    allowed_parameters,
                    "Los parámetros contienen campos no admitidos.",
                )
                parameters = {}
                for field in fields:
                    name = str(field["name"])
                    try:
                        raw_value = raw_parameters[name]
                        if isinstance(raw_value, bool):
                            raise TypeError
                        value = float(raw_value)
                    except (KeyError, TypeError, ValueError):
                        raise FormulaWebInputError(
                            f"El parámetro {field['label']} no contiene un número válido."
                        ) from None
                    if not math.isfinite(value):
                        raise FormulaWebInputError(
                            f"El parámetro {field['label']} no contiene un número válido."
                        )
                    display_factor = float(field.get("display_factor", 1.0))
                    minimum = float(field["min"]) / display_factor
                    maximum = float(field["max"]) / display_factor
                    if not minimum <= value <= maximum:
                        raise FormulaWebInputError(
                            f"El parámetro {field['label']} debe estar entre "
                            f"{field['min']:g} y {field['max']:g}{field.get('suffix', '')}."
                        )
                    parameters[name] = value
                definition = replace(
                    self.methods[method_id],
                    parameters=self._engine_parameters(method_id, parameters),
                    parameter_origin="USER_DEFINED",
                    sources=(),
                )
                variant = {"variant_id": "custom", "origin": "USER_DEFINED"}
            else:
                if "parameters" in raw:
                    raise FormulaWebInputError(
                        "Los parámetros libres solo se admiten en una configuración personalizada."
                    )
                definition = options.get(variant_id)
                if definition is None:
                    raise FormulaWebInputError("La variante seleccionada no está disponible.")
                variant = {"variant_id": variant_id, "origin": "DOCUMENTED"}
            selected.append((method_id, definition, variant))
        return tuple(selected)

    def _scenario(
        self, payload: Mapping[str, Any], scenario_id: str
    ) -> tuple[Scenario, dict[str, str]]:
        self._reject_unknown_keys(
            payload,
            {"tender_price", "pmax", "offers"},
            "El escenario contiene campos no admitidos.",
        )
        try:
            raw_tender_price = payload["tender_price"]
            raw_pmax = payload["pmax"]
            if isinstance(raw_tender_price, bool) or isinstance(raw_pmax, bool):
                raise TypeError
            tender_price = float(raw_tender_price)
            pmax = float(raw_pmax)
        except (KeyError, TypeError, ValueError):
            raise FormulaWebInputError("Presupuesto y puntuación máxima deben ser números válidos.") from None
        if not math.isfinite(tender_price) or tender_price <= 0:
            raise FormulaWebInputError("El presupuesto de licitación debe ser mayor que cero.")
        if not math.isfinite(pmax) or pmax <= 0:
            raise FormulaWebInputError("La puntuación máxima debe ser mayor que cero.")
        max_tender_price = float(self.config.get("max_tender_price", 1_000_000_000_000))
        max_pmax = float(self.config.get("max_pmax", 10_000))
        if tender_price > max_tender_price:
            raise FormulaWebInputError(
                f"El presupuesto no puede superar {max_tender_price:g}."
            )
        if pmax > max_pmax:
            raise FormulaWebInputError(f"La puntuación máxima no puede superar {max_pmax:g}.")
        raw_offers = payload.get("offers")
        max_offers = int(self.config.get("max_offers", 20))
        if not isinstance(raw_offers, list) or not 2 <= len(raw_offers) <= max_offers:
            raise FormulaWebInputError(f"Introduce entre 2 y {max_offers} ofertas.")

        ids = []
        names: dict[str, str] = {}
        prices = []
        for index, raw in enumerate(raw_offers, start=1):
            if not isinstance(raw, Mapping):
                raise FormulaWebInputError("Cada oferta debe incluir un nombre y un precio.")
            self._reject_unknown_keys(
                raw,
                {"offer_id", "name", "price"},
                "Una oferta contiene campos no admitidos.",
            )
            offer_id = str(raw.get("offer_id", f"offer-{index}")).strip()
            name = str(raw.get("name", f"Oferta {index}")).strip()
            if not offer_id or len(offer_id) > 80 or offer_id in names:
                raise FormulaWebInputError("Las ofertas deben tener identificadores únicos.")
            if not name or len(name) > 40:
                raise FormulaWebInputError("El nombre de cada oferta debe tener entre 1 y 40 caracteres.")
            try:
                raw_price = raw["price"]
                if isinstance(raw_price, bool):
                    raise TypeError
                price = float(raw_price)
            except (KeyError, TypeError, ValueError):
                raise FormulaWebInputError(f"El precio de la oferta {name} no es válido.") from None
            if not math.isfinite(price) or price <= 0 or price > tender_price:
                raise FormulaWebInputError(
                    f"El precio de la oferta {name} debe ser mayor que cero y no superar el presupuesto."
                )
            ids.append(offer_id)
            names[offer_id] = name
            prices.append(price)
        return (
            Scenario(
                scenario_id=scenario_id,
                label="Escenario del comparador",
                tender_price=tender_price,
                pmax=pmax,
                offers=tuple(prices),
                offer_ids=tuple(ids),
                synthetic=True,
            ),
            names,
        )

    @staticmethod
    def _reject_unknown_keys(
        value: Mapping[str, Any], allowed: set[str], message: str
    ) -> None:
        if any(not isinstance(key, str) or key not in allowed for key in value):
            raise FormulaWebInputError(message)

    def _configured_url(self, environment_name: str, key: str, *, section: str | None = None) -> str:
        configured: Any = self.config
        if section:
            configured = configured.get(section, {}) if isinstance(configured, Mapping) else {}
        raw = os.environ.get(environment_name, str(configured.get(key, ""))).strip()
        if raw and not raw.startswith(("https://", "mailto:")):
            raise ValueError(f"Invalid public URL configured for {key}")
        return raw

    @staticmethod
    def _feedback_url() -> str:
        raw = os.environ.get("FORMULA_FEEDBACK_URL", "").strip()
        if not raw:
            return "/contacto"
        parsed = urlsplit(raw)
        relative = (
            raw.startswith("/")
            and not raw.startswith("//")
            and not parsed.scheme
            and not parsed.netloc
        )
        external = (
            parsed.scheme == "https"
            and bool(parsed.netloc)
            and parsed.username is None
            and parsed.password is None
        )
        if not relative and not external:
            raise ValueError("Invalid public URL configured for feedback_url")
        return raw

    def _public_result(
        self,
        method_id: str,
        definition: MethodDefinition,
        variant: Mapping[str, Any],
        simulation: Any,
        metric: Mapping[str, Any],
    ) -> dict[str, Any]:
        public = self.public_methods[method_id]
        return {
            "method_id": method_id,
            "name": public["name"],
            "short_name": public["short_name"],
            "description": public["description"],
            "expression": definition.expression,
            "equation_plain": public["equation_plain"],
            "equation_mathml": public["equation_mathml"],
            "equation_offers_plain": public["equation_offers_plain"],
            "equation_offers_mathml": public["equation_offers_mathml"],
            "equation_discounts_plain": public["equation_discounts_plain"],
            "equation_discounts_mathml": public["equation_discounts_mathml"],
            "family": public["family"],
            "equivalence_group": public["equivalence_group"],
            "special_cases": list(public["special_cases"]),
            "parameters": self._public_parameters(method_id, definition.parameters),
            "parameter_origin": variant["origin"],
            "variant_label": (
                "Valores introducidos por el usuario"
                if variant["origin"] == "USER_DEFINED"
                else "n = Bmax / 5 · autoajustada"
                if variant["origin"] == "BMAX_DERIVED"
                else self._variant_label(method_id, definition.parameters)
            ),
            "depends_on_other_offers": bool(definition.set_dependencies),
            "dependency": public["dependency"],
            "behavior": public["behavior"],
            "reference_type": public["reference_type"],
            "effective_score_range": float(metric["effective_score_range"]),
            "effective_range_ratio": float(metric["effective_range_ratio"]),
            "score_stddev": float(metric["score_stddev"]),
            "sensitivity_points_per_one_percent": float(
                metric["mean_local_sensitivity_points_per_one_percent_pl"]
            ),
            "rows": [
                {
                    "offer_id": row.offer_id,
                    "price": row.price,
                    "discount_pct": row.discount_rate * 100.0,
                    "score": row.score,
                    "score_pct": row.score_normalized * 100.0,
                    "rank": row.rank,
                }
                for row in simulation.rows
            ],
        }

    @staticmethod
    def _table_rows(
        scenario: Scenario,
        offer_names: Mapping[str, str],
        methods: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        score_maps = {
            str(method["method_id"]): {
                str(row["offer_id"]): float(row["score"])
                for row in method["rows"]
            }
            for method in methods
        }
        return [
            {
                "offer_id": offer_id,
                "name": offer_names[offer_id],
                "price": price,
                "discount_pct": (scenario.tender_price - price) / scenario.tender_price * 100.0,
                "scores": {
                    str(method["method_id"]): score_maps[str(method["method_id"])][offer_id]
                    for method in methods
                },
            }
            for offer_id, price in zip(scenario.resolved_offer_ids(), scenario.offers)
        ]

    def _curves(
        self,
        scenario: Scenario,
        selected: Sequence[tuple[str, MethodDefinition, Mapping[str, Any]]],
        *,
        expected_bmax_pct: float,
        observed_bmax_pct: float,
        visual_bmax_pct: float,
    ) -> list[dict[str, Any]]:
        curves = []
        for method_id, definition, variant in selected:
            is_absolute = not definition.set_dependencies
            expected_limit = visual_bmax_pct if is_absolute else expected_bmax_pct
            expected_definition = self._definition_for_reference(
                definition, variant, expected_bmax_pct
            )
            expected_points = self._curve_points(
                scenario,
                expected_definition,
                expected_limit,
                scenario_id="EXPECTED_CURVE",
            )
            if not expected_points:
                continue
            resulting_points = []
            if not is_absolute:
                resulting_points = self._curve_points(
                    scenario,
                    definition,
                    observed_bmax_pct,
                    scenario_id="RESULTING_CURVE",
                )
            curves.append(
                {
                    "method_id": method_id,
                    "name": self.public_methods[method_id]["short_name"],
                    "points": expected_points,
                    "expected_points": expected_points,
                    "resulting_points": resulting_points,
                    "curves_coincide": is_absolute,
                    "expected_reference_pct": expected_bmax_pct,
                    "observed_reference_pct": observed_bmax_pct,
                    "expected_parameters": self._public_parameters(
                        method_id, expected_definition.parameters
                    ),
                    "resulting_parameters": self._public_parameters(
                        method_id, definition.parameters
                    ),
                }
            )
        return curves

    def _variant_comparisons(
        self,
        scenario: Scenario,
        selected: Sequence[tuple[str, MethodDefinition, Mapping[str, Any]]],
        expected_bmax_pct: float,
    ) -> list[dict[str, Any]]:
        prices = self._curve_prices(scenario, expected_bmax_pct)
        ids = tuple(f"variant-{index}" for index in range(len(prices)))
        result = []
        for method_id, selected_definition, selected_variant in selected:
            documented = list(self.variant_definitions[method_id])
            if len(documented) <= 1 and selected_variant["origin"] != "USER_DEFINED":
                continue
            series = []
            for _, definition in documented:
                simulation = self.simulation_engine.evaluate_method(
                    definition,
                    scenario.tender_price,
                    prices,
                    scenario.pmax,
                    scenario_id="VARIANTS",
                    offer_ids=ids,
                )
                if simulation.status == "SIMULATION_OK":
                    series.append(
                        {
                            "label": self._variant_label(method_id, definition.parameters),
                            "origin": "DOCUMENTED",
                            "points": [
                                {
                                    "discount_pct": row.discount_rate * 100.0,
                                    "score_pct": row.score_normalized * 100.0,
                                }
                                for row in sorted(simulation.rows, key=lambda item: item.discount_rate)
                            ],
                        }
                    )
            if selected_variant["origin"] in {"USER_DEFINED", "BMAX_DERIVED"}:
                comparison_definition = self._definition_for_reference(
                    selected_definition, selected_variant, expected_bmax_pct
                )
                simulation = self.simulation_engine.evaluate_method(
                    comparison_definition,
                    scenario.tender_price,
                    prices,
                    scenario.pmax,
                    scenario_id="CUSTOM_VARIANT",
                    offer_ids=ids,
                )
                if simulation.status == "SIMULATION_OK":
                    series.append(
                        {
                            "label": (
                                "n = Bmax / 5"
                                if selected_variant["origin"] == "BMAX_DERIVED"
                                else "Valores del usuario"
                            ),
                            "origin": selected_variant["origin"],
                            "points": [
                                {
                                    "discount_pct": row.discount_rate * 100.0,
                                    "score_pct": row.score_normalized * 100.0,
                                }
                                for row in sorted(simulation.rows, key=lambda item: item.discount_rate)
                            ],
                        }
                    )
            result.append(
                {
                    "method_id": method_id,
                    "name": self.public_methods[method_id]["name"],
                    "series": series,
                }
            )
        return result

    def _impacts(
        self,
        baseline: Scenario,
        current: Scenario,
        selected: Sequence[tuple[str, MethodDefinition, Mapping[str, Any]]],
    ) -> list[dict[str, Any]]:
        baseline_ids = baseline.resolved_offer_ids()
        current_ids = current.resolved_offer_ids()
        baseline_prices = dict(zip(baseline_ids, baseline.offers))
        current_prices = dict(zip(current_ids, current.offers))
        common_ids = [offer_id for offer_id in current_ids if offer_id in baseline_prices]
        impacts = []
        for method_id, definition, variant in selected:
            before_definition = self._definition_for_reference(
                definition, variant, self._scenario_bmax_pct(baseline)
            )
            after_definition = self._definition_for_reference(
                definition, variant, self._scenario_bmax_pct(current)
            )
            before = self.simulation_engine.evaluate_scenario(before_definition, baseline)
            after = self.simulation_engine.evaluate_scenario(after_definition, current)
            if before.status != "SIMULATION_OK" or after.status != "SIMULATION_OK":
                continue
            before_scores = {row.offer_id: row.score for row in before.rows}
            after_scores = {row.offer_id: row.score for row in after.rows}
            changes = []
            for offer_id in common_ids:
                delta = after_scores[offer_id] - before_scores[offer_id]
                same_price = math.isclose(
                    baseline_prices[offer_id], current_prices[offer_id], rel_tol=0.0, abs_tol=1e-9
                )
                changes.append(
                    {
                        "offer_id": offer_id,
                        "same_price": same_price,
                        "score_before": before_scores[offer_id],
                        "score_after": after_scores[offer_id],
                        "delta": delta,
                    }
                )
            impacts.append(
                {
                    "method_id": method_id,
                    "name": self.public_methods[method_id]["short_name"],
                    "depends_on_other_offers": bool(definition.set_dependencies),
                    "changed_offer_count": sum(abs(item["delta"]) > 1e-9 for item in changes),
                    "unchanged_price_changed_count": sum(
                        item["same_price"] and abs(item["delta"]) > 1e-9 for item in changes
                    ),
                    "max_absolute_change": max(
                        (abs(item["delta"]) for item in changes), default=0.0
                    ),
                    "changes": changes,
                }
            )
        return impacts

    @staticmethod
    def _change_context(baseline: Scenario, current: Scenario) -> str:
        if not math.isclose(baseline.tender_price, current.tender_price) or not math.isclose(
            baseline.pmax, current.pmax
        ):
            return "TENDER_OR_PMAX_CHANGED"
        baseline_prices = dict(zip(baseline.resolved_offer_ids(), baseline.offers))
        current_prices = dict(zip(current.resolved_offer_ids(), current.offers))
        common = baseline_prices.keys() & current_prices.keys()
        if all(math.isclose(baseline_prices[key], current_prices[key]) for key in common):
            return "ONLY_OFFER_SET"
        return "OFFER_PRICES_CHANGED"

    def _curve_points(
        self,
        scenario: Scenario,
        definition: MethodDefinition,
        maximum_discount_pct: float,
        *,
        scenario_id: str,
    ) -> list[dict[str, float]]:
        prices = self._curve_prices(scenario, maximum_discount_pct)
        ids = tuple(f"{scenario_id.lower()}-{index}" for index in range(len(prices)))
        simulation = self.simulation_engine.evaluate_method(
            definition,
            scenario.tender_price,
            prices,
            scenario.pmax,
            scenario_id=scenario_id,
            offer_ids=ids,
        )
        if simulation.status != "SIMULATION_OK":
            return []
        return [
            {
                "price": row.price,
                "discount_pct": row.discount_rate * 100.0,
                "score": row.score,
                "score_pct": row.score_normalized * 100.0,
            }
            for row in sorted(simulation.rows, key=lambda item: item.discount_rate)
        ]

    @staticmethod
    def _curve_prices(
        scenario: Scenario, maximum_discount_pct: float
    ) -> tuple[float, ...]:
        return tuple(
            scenario.tender_price
            * (1.0 - (maximum_discount_pct * index / (CURVE_POINT_COUNT - 1)) / 100.0)
            for index in range(CURVE_POINT_COUNT)
        )

    @staticmethod
    def _visual_bmax(expected_bmax_pct: float, observed_bmax_pct: float) -> float:
        upper = max(expected_bmax_pct, observed_bmax_pct)
        nearest_tick = round(upper / 5.0) * 5.0
        if math.isclose(upper, nearest_tick, rel_tol=0.0, abs_tol=1e-6):
            return min(100.0, nearest_tick)
        return min(100.0, math.ceil((upper - 1e-9) / 5.0) * 5.0)

    @staticmethod
    def _expected_bmax(raw: Any) -> float:
        if isinstance(raw, bool):
            raise FormulaWebInputError("La Bmax teórica debe ser un número válido.")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise FormulaWebInputError("La Bmax teórica debe ser un número válido.") from None
        if not math.isfinite(value) or not 0 < value < 100:
            raise FormulaWebInputError("La Bmax teórica debe estar entre 0 y 100 %.")
        return value

    @staticmethod
    def _with_curve_role(method: Mapping[str, Any]) -> dict[str, Any]:
        value = dict(method)
        if method["reference_type"] == "Absoluta":
            value["curve_explanation"] = (
                "No cambia al variar las ofertas de terceros; la curva esperada y la resultante coinciden."
            )
        elif method["reference_type"] == "Mixta":
            value["curve_explanation"] = (
                "El primer tramo usa parámetros fijos y el tramo final depende de la Bmax observada."
            )
        else:
            value["curve_explanation"] = (
                "La curva esperada usa la Bmax teórica y la resultante las referencias observadas."
            )
        return value

    def _add_theoretical_scores(
        self,
        rows: list[dict[str, Any]],
        scenario: Scenario,
        selected: Sequence[tuple[str, MethodDefinition, Mapping[str, Any]]],
        expected_bmax_pct: float,
    ) -> None:
        reference_price = scenario.tender_price * (1.0 - expected_bmax_pct / 100.0)
        for row in rows:
            row["theoretical_scores"] = {}
            row["score_differences"] = {}
            for method_id, definition, variant in selected:
                expected_definition = self._definition_for_reference(
                    definition, variant, expected_bmax_pct
                )
                discount_pct = float(row["discount_pct"])
                if expected_definition.set_dependencies and discount_pct > expected_bmax_pct + 1e-9:
                    theoretical_score = None
                else:
                    target_price = float(row["price"])
                    prices = (
                        (target_price, reference_price)
                        if expected_definition.set_dependencies
                        else (target_price,)
                    )
                    simulation = self.simulation_engine.evaluate_method(
                        expected_definition,
                        scenario.tender_price,
                        prices,
                        scenario.pmax,
                        scenario_id="THEORETICAL_POINT",
                        offer_ids=tuple(f"point-{index}" for index in range(len(prices))),
                    )
                    theoretical_score = (
                        simulation.rows[0].score
                        if simulation.status == "SIMULATION_OK"
                        else None
                    )
                row["theoretical_scores"][method_id] = theoretical_score
                row["score_differences"][method_id] = (
                    float(row["scores"][method_id]) - theoretical_score
                    if theoretical_score is not None
                    else None
                )

    @staticmethod
    def _scenario_bmax_pct(scenario: Scenario) -> float:
        return max(
            (scenario.tender_price - value) / scenario.tender_price * 100.0
            for value in scenario.offers
        )

    @staticmethod
    def _definition_for_reference(
        definition: MethodDefinition,
        variant: Mapping[str, Any],
        bmax_pct: float,
    ) -> MethodDefinition:
        if variant["origin"] != "BMAX_DERIVED":
            return definition
        return replace(
            definition,
            parameters={"n": bmax_pct / 5.0},
            parameter_origin="BMAX_DERIVED",
        )

    @staticmethod
    def _public_parameters(
        method_id: str, parameters: Mapping[str, float]
    ) -> dict[str, float]:
        if method_id == "DISCOUNT_MAX_POWER":
            return {"k": 1.0 / float(parameters["n"])}
        if method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS":
            return {
                "n": float(parameters["first_slope"]),
                "B": float(parameters["threshold"]) * 100.0,
                "k": float(parameters["tail_points"]),
            }
        return {str(key): float(value) for key, value in parameters.items()}

    @staticmethod
    def _engine_parameters(
        method_id: str, parameters: Mapping[str, float]
    ) -> dict[str, float]:
        if method_id == "DISCOUNT_MAX_POWER":
            return {"n": 1.0 / float(parameters["k"])}
        if method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS":
            return {
                "first_slope": float(parameters["n"]),
                "threshold": float(parameters["B"]) / 100.0,
                "tail_points": float(parameters["k"]),
            }
        return {str(key): float(value) for key, value in parameters.items()}

    def _public_cases(self) -> list[dict[str, Any]]:
        cases = self.case_catalog.cases()
        for case in cases:
            if case.get("actual_method_id") in {
                "DISCOUNT_MAX_POWER",
                "DISCOUNT_THRESHOLD_TWO_SEGMENTS",
            }:
                case["actual_parameters"] = self._public_parameters(
                    case["actual_method_id"], case["actual_parameters"]
                )
        return cases

    @staticmethod
    def _same_parameters(left: Mapping[str, float], right: Mapping[str, float]) -> bool:
        return left.keys() == right.keys() and all(
            math.isclose(float(left[key]), float(right[key]), rel_tol=0.0, abs_tol=1e-12)
            for key in left
        )

    @staticmethod
    def _variant_label(method_id: str, parameters: Mapping[str, float]) -> str:
        if not parameters:
            return "Configuración confirmada"
        if method_id == "NORMALIZED_PRICE_GAP_POWER":
            suffix = " · caso lineal documentado" if math.isclose(parameters["n"], 1.0) else " · documentada"
            return f"n = {parameters['n']:g}{suffix}"
        if method_id == "DISCOUNT_MAX_POWER":
            return f"k = {1.0 / parameters['n']:g} · documentada"
        if method_id == "EXPONENTIAL_SATURATING_DISCOUNT":
            return f"k = {parameters['k']:g} · documentada"
        if method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS":
            return (
                f"n = {parameters['first_slope']:g} · B = "
                f"{parameters['threshold'] * 100:g} % · k = {parameters['tail_points']:g} pt"
            )
        return "Configuración documentada"

    @staticmethod
    def _public_engine_error(error: str) -> str:
        if "Bmax is zero" in error or "PL - Omin is zero" in error:
            return "Al menos una oferta debe ser inferior al presupuesto para comparar estas fórmulas."
        if "Scores outside" in error:
            return "La combinación de escenario y parámetros produce puntuaciones fuera del rango válido."
        if "Missing or invalid parameter" in error:
            return "Falta un parámetro válido para una de las fórmulas seleccionadas."
        return "El escenario no puede evaluarse con las fórmulas seleccionadas."
