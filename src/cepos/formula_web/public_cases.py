"""Load the anonymous, deployable derivative of the real tender cases."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Mapping


PUBLIC_CASE_FIELDS = (
    "case_id",
    "label",
    "contract_type",
    "complexity_level",
    "tender_price",
    "pmax",
    "non_price_max",
    "minimum_offer",
    "maximum_discount_pct",
    "mean_discount_pct",
    "actual_method_id",
    "actual_method_name",
    "actual_expression",
    "actual_formula_supported",
    "actual_parameters",
    "expected_maximum_discount_pct",
    "best_technical_offer",
    "lowest_price_offer",
    "actual_awardee",
    "offers",
    "note",
)

CASE_KEYS = frozenset(PUBLIC_CASE_FIELDS)
VALID_COMPLEXITY_LEVELS = {"ESTÁNDAR", "MEDIA", "ALTA", "MUY ALTA"}

OFFER_KEYS = {
    "offer_id",
    "name",
    "price",
    "discount_eur",
    "discount_pct",
    "non_price_points",
    "economic_points",
    "total_points",
}


class PublicFormulaCaseCatalog:
    """Validate that public cases contain only the documented anonymous contract."""

    def __init__(self, artifact_path: Path) -> None:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        if artifact.get("schema_version") != "formula_public_cases_v2":
            raise ValueError("Unsupported public formula case catalog")
        raw_cases = artifact.get("cases")
        if not isinstance(raw_cases, list) or artifact.get("case_count") != len(raw_cases):
            raise ValueError("Invalid public formula case count")
        self.source_sha256 = str(artifact.get("source_sha256", ""))
        self._cases = tuple(self._validate_case(index, raw) for index, raw in enumerate(raw_cases, 1))

    @staticmethod
    def _number(value: Any, label: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Invalid number in {label}")
        result = float(value)
        if not math.isfinite(result):
            raise ValueError(f"Non-finite number in {label}")
        return result

    @classmethod
    def _validate_case(cls, index: int, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or set(raw) != CASE_KEYS:
            raise ValueError("Invalid public formula case fields")
        contract_type = str(raw["contract_type"])
        expected_label = f"Caso {index} · {contract_type}"
        if contract_type not in {"OBRAS", "SERVICIOS", "SUMINISTROS"}:
            raise ValueError("Invalid public contract type")
        if raw["case_id"] != f"case-{index}" or raw["label"] != expected_label:
            raise ValueError("Invalid public case identity")
        complexity_level = raw["complexity_level"]
        if complexity_level is not None and complexity_level not in VALID_COMPLEXITY_LEVELS:
            raise ValueError("Invalid public case complexity level")

        tender_price = cls._number(raw["tender_price"], expected_label)
        pmax = cls._number(raw["pmax"], expected_label)
        offers = raw["offers"]
        if not isinstance(offers, list) or not 2 <= len(offers) <= 20:
            raise ValueError("Invalid public case offers")
        checked_offers = []
        for offer_index, offer in enumerate(offers, 1):
            if not isinstance(offer, Mapping) or set(offer) != OFFER_KEYS:
                raise ValueError("Invalid public offer fields")
            expected_name = f"LIC-{offer_index}"
            if offer["offer_id"] != f"lic-{offer_index}" or offer["name"] != expected_name:
                raise ValueError("Public offers must use LIC-n identifiers")
            checked = dict(offer)
            for key in OFFER_KEYS - {"offer_id", "name"}:
                checked[key] = cls._number(offer[key], f"{expected_label} {expected_name}")
            if checked["price"] <= 0 or checked["price"] > tender_price:
                raise ValueError("Public offer price is outside the tender range")
            checked_offers.append(checked)

        offer_names = {offer["name"] for offer in checked_offers}
        for field in ("best_technical_offer", "lowest_price_offer", "actual_awardee"):
            if raw[field] not in offer_names:
                raise ValueError("Public case result references an unknown offer")

        checked_case = {key: raw[key] for key in PUBLIC_CASE_FIELDS}
        for key in (
            "tender_price",
            "pmax",
            "non_price_max",
            "minimum_offer",
            "maximum_discount_pct",
            "mean_discount_pct",
            "expected_maximum_discount_pct",
        ):
            checked_case[key] = cls._number(raw[key], f"{expected_label} {key}")
        checked_case["offers"] = checked_offers
        checked_case["actual_parameters"] = {
            str(key): cls._number(value, f"{expected_label} parameter")
            for key, value in dict(raw["actual_parameters"]).items()
        }
        return checked_case

    def cases(self) -> list[dict[str, Any]]:
        return json.loads(json.dumps(self._cases, ensure_ascii=False))
