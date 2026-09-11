"""Deterministic evaluators for normalized price-scoring methods."""

from __future__ import annotations

import math
from typing import Mapping, Sequence

from .models import MethodDefinition, OfferScore, Scenario, SimulationResult, SIMULATION_VERSION


class FormulaSimulationEngine:
    """Evaluate normalized methods without executing workbook formulas."""

    def evaluate_method(
        self,
        method: MethodDefinition,
        tender_price: float,
        offers: Sequence[float],
        pmax: float,
        parameters: Mapping[str, float] | None = None,
        *,
        scenario_id: str = "AD_HOC",
        offer_ids: Sequence[str] = (),
    ) -> SimulationResult:
        scenario = Scenario(
            scenario_id=scenario_id,
            label=scenario_id,
            tender_price=float(tender_price),
            pmax=float(pmax),
            offers=tuple(float(value) for value in offers),
            offer_ids=tuple(offer_ids),
        )
        merged = dict(method.parameters)
        if parameters:
            merged.update({str(key): float(value) for key, value in parameters.items()})
        return self.evaluate_scenario(method, scenario, parameters=merged)

    def evaluate_scenario(
        self,
        method: MethodDefinition,
        scenario: Scenario,
        *,
        parameters: Mapping[str, float] | None = None,
    ) -> SimulationResult:
        errors = self._validate_scenario(scenario)
        params = dict(method.parameters if parameters is None else parameters)
        errors.extend(self._validate_parameters(method.method_id, params))
        if errors:
            return self._result(method, scenario, params, "INVALID_INPUT", errors=errors)

        omin = min(scenario.offers)
        discounts = tuple((scenario.tender_price - offer) / scenario.tender_price for offer in scenario.offers)
        bmax = max(discounts)
        bmean = sum(discounts) / len(discounts)
        derived = {"OMIN": omin, "BMAX": bmax, "BMEAN": bmean}
        try:
            raw_scores = [
                self._score(
                    method.method_id,
                    offer=offer,
                    discount=discount,
                    tender_price=scenario.tender_price,
                    pmax=scenario.pmax,
                    omin=omin,
                    bmax=bmax,
                    parameters=params,
                )
                for offer, discount in zip(scenario.offers, discounts)
            ]
        except (ArithmeticError, OverflowError, ValueError) as exc:
            return self._result(
                method,
                scenario,
                params,
                "NUMERIC_ERROR",
                derived=derived,
                errors=(str(exc),),
            )

        if any(not math.isfinite(score) for score in raw_scores):
            return self._result(
                method,
                scenario,
                params,
                "NUMERIC_ERROR",
                derived=derived,
                errors=("Simulation produced NaN or infinity",),
            )
        tolerance = max(1e-9, scenario.pmax * 1e-9)
        out_of_range = [score for score in raw_scores if score < -tolerance or score > scenario.pmax + tolerance]
        if out_of_range:
            return self._result(
                method,
                scenario,
                params,
                "SCORE_OUT_OF_RANGE",
                derived=derived,
                errors=(f"Scores outside [0, Pmax]: {out_of_range}",),
            )

        ranking = sorted(range(len(raw_scores)), key=lambda index: (-raw_scores[index], scenario.offers[index], index))
        rank_by_index = {index: rank for rank, index in enumerate(ranking, start=1)}
        ids = scenario.resolved_offer_ids()
        rows = tuple(
            OfferScore(
                offer_id=ids[index],
                price=offer,
                discount_amount=scenario.tender_price - offer,
                discount_rate=discounts[index],
                score=raw_scores[index],
                score_normalized=raw_scores[index] / scenario.pmax,
                rank=rank_by_index[index],
            )
            for index, offer in enumerate(scenario.offers)
        )
        warnings: tuple[str, ...] = ()
        if method.method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS" and bmax <= params["threshold"]:
            warnings = ("All offers remain in the first documented segment",)
        return self._result(
            method,
            scenario,
            params,
            "SIMULATION_OK",
            derived=derived,
            rows=rows,
            warnings=warnings,
        )

    @staticmethod
    def _score(
        method_id: str,
        *,
        offer: float,
        discount: float,
        tender_price: float,
        pmax: float,
        omin: float,
        bmax: float,
        parameters: Mapping[str, float],
    ) -> float:
        if method_id == "INVERSE_PRICE_PROPORTIONAL":
            return pmax * omin / offer
        if method_id == "LINEAR_DISCOUNT_MAX":
            if bmax == 0:
                raise ZeroDivisionError("Bmax is zero")
            return pmax * discount / bmax
        if method_id == "AFFINE_MIN_REFERENCE_OVER_TENDER_PRICE":
            return pmax * (1.0 - (offer - omin) / tender_price)
        if method_id == "NORMALIZED_PRICE_GAP_POWER":
            denominator = tender_price - omin
            if denominator == 0:
                raise ZeroDivisionError("PL - Omin is zero")
            return pmax * (1.0 - ((offer - omin) / denominator) ** parameters["n"])
        if method_id == "DISCOUNT_MAX_POWER":
            if bmax == 0:
                raise ZeroDivisionError("Bmax is zero")
            return pmax * (discount / bmax) ** parameters["n"]
        if method_id == "EXPONENTIAL_SATURATING_DISCOUNT":
            return pmax * (1.0 - math.exp(-parameters["k"] * 100.0 * discount))
        if method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS":
            threshold = parameters["threshold"]
            first_slope = parameters["first_slope"]
            tail_points = parameters["tail_points"]
            documented_pmax = first_slope * threshold * 100.0 + tail_points
            scale = pmax / documented_pmax
            if discount <= threshold:
                return scale * first_slope * discount * 100.0
            if bmax == threshold:
                raise ZeroDivisionError("Bmax - threshold is zero")
            return scale * (
                first_slope * threshold * 100.0
                + tail_points * (discount - threshold) / (bmax - threshold)
            )
        raise ValueError(f"Unsupported confirmed method: {method_id}")

    @staticmethod
    def _validate_scenario(scenario: Scenario) -> list[str]:
        errors: list[str] = []
        if not math.isfinite(scenario.tender_price) or scenario.tender_price <= 0:
            errors.append("Tender price must be finite and greater than zero")
        if not math.isfinite(scenario.pmax) or scenario.pmax <= 0:
            errors.append("Pmax must be finite and greater than zero")
        if not scenario.offers:
            errors.append("At least one offer is required")
        if scenario.offer_ids and len(scenario.offer_ids) != len(scenario.offers):
            errors.append("Offer IDs and offers must have the same length")
        for offer in scenario.offers:
            if not math.isfinite(offer) or offer <= 0:
                errors.append(f"Offer must be finite and greater than zero: {offer}")
            elif scenario.tender_price > 0 and offer > scenario.tender_price:
                errors.append(f"Offer exceeds tender price: {offer}")
        return errors

    @staticmethod
    def _validate_parameters(method_id: str, parameters: Mapping[str, float]) -> list[str]:
        required = {
            "NORMALIZED_PRICE_GAP_POWER": ("n",),
            "DISCOUNT_MAX_POWER": ("n",),
            "EXPONENTIAL_SATURATING_DISCOUNT": ("k",),
            "DISCOUNT_THRESHOLD_TWO_SEGMENTS": ("first_slope", "threshold", "tail_points"),
        }.get(method_id, ())
        errors: list[str] = []
        for name in required:
            value = parameters.get(name)
            if value is None or not math.isfinite(value):
                errors.append(f"Missing or invalid parameter: {name}")
        if "n" in required and isinstance(parameters.get("n"), (int, float)) and parameters["n"] <= 0:
            errors.append("Exponent n must be greater than zero")
        if "k" in required and isinstance(parameters.get("k"), (int, float)) and parameters["k"] <= 0:
            errors.append("Coefficient k must be greater than zero")
        if method_id == "DISCOUNT_THRESHOLD_TWO_SEGMENTS" and not errors:
            if not 0 < parameters["threshold"] < 1:
                errors.append("Threshold must be within (0, 1)")
            if parameters["first_slope"] <= 0 or parameters["tail_points"] <= 0:
                errors.append("Piecewise coefficients must be greater than zero")
        return errors

    @staticmethod
    def _result(
        method: MethodDefinition,
        scenario: Scenario,
        parameters: Mapping[str, float],
        status: str,
        *,
        derived: Mapping[str, float] | None = None,
        rows: tuple[OfferScore, ...] = (),
        errors: Sequence[str] = (),
        warnings: Sequence[str] = (),
    ) -> SimulationResult:
        return SimulationResult(
            simulation_version=SIMULATION_VERSION,
            status=status,
            method_id=method.method_id,
            method_signature=method.method_signature,
            method_name=method.display_name,
            expression=method.expression,
            parameters=dict(parameters),
            parameter_origin=method.parameter_origin,
            scenario=scenario.to_dict(),
            derived_variables=dict(derived or {}),
            rows=rows,
            errors=tuple(errors),
            warnings=tuple(warnings),
            traceability=method.sources,
        )
