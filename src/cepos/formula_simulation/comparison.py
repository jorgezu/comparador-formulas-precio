"""Objective comparison metrics for formula-method simulations."""

from __future__ import annotations

import math
from statistics import fmean, pstdev
from typing import Any, Iterable, Sequence

from .engine import FormulaSimulationEngine
from .models import ComparisonResult, MethodDefinition, Scenario, SimulationResult, SIMULATION_VERSION


class FormulaComparisonEngine:
    def __init__(self, simulation_engine: FormulaSimulationEngine | None = None) -> None:
        self.simulation_engine = simulation_engine or FormulaSimulationEngine()

    def compare(
        self,
        methods: Sequence[MethodDefinition],
        scenario: Scenario,
    ) -> ComparisonResult:
        simulations = tuple(
            self.simulation_engine.evaluate_scenario(method, scenario) for method in methods
        )
        successful = tuple(item for item in simulations if item.status == "SIMULATION_OK")
        by_id = {method.method_id: method for method in methods}
        metrics = tuple(
            self._metrics(by_id[result.method_id], scenario, result)
            for result in successful
        )
        pairwise = self._pairwise(successful)
        ranking = self._ranking_summary(successful)
        errors = tuple(
            f"{item.method_id}: {'; '.join(item.errors)}"
            for item in simulations if item.status != "SIMULATION_OK"
        )
        return ComparisonResult(
            simulation_version=SIMULATION_VERSION,
            scenario=scenario.to_dict(),
            simulations=simulations,
            metrics=metrics,
            pairwise_similarity=pairwise,
            ranking=ranking,
            errors=errors,
        )

    def added_extreme_offer_test(
        self,
        methods: Sequence[MethodDefinition],
        base_scenario: Scenario,
        new_offer: float,
        *,
        new_offer_id: str = "E",
    ) -> dict[str, Any]:
        base = self.compare(methods, base_scenario)
        expanded = Scenario(
            scenario_id=f"{base_scenario.scenario_id}_PLUS_EXTREME",
            label=f"{base_scenario.label} + oferta extrema",
            tender_price=base_scenario.tender_price,
            pmax=base_scenario.pmax,
            offers=base_scenario.offers + (float(new_offer),),
            offer_ids=base_scenario.resolved_offer_ids() + (new_offer_id,),
            description="Contrafactual sintético: se añade una oferta mínima extrema.",
        )
        after = self.compare(methods, expanded)
        after_by_method = {item.method_id: item for item in after.simulations}
        changes: list[dict[str, Any]] = []
        for before in base.simulations:
            later = after_by_method[before.method_id]
            if before.status != "SIMULATION_OK" or later.status != "SIMULATION_OK":
                changes.append({
                    "method_id": before.method_id,
                    "status": "NOT_COMPARABLE",
                    "errors": list(before.errors + later.errors),
                })
                continue
            later_rows = {row.offer_id: row for row in later.rows}
            deltas = [
                {
                    "offer_id": row.offer_id,
                    "score_before": row.score,
                    "score_after": later_rows[row.offer_id].score,
                    "delta": later_rows[row.offer_id].score - row.score,
                }
                for row in before.rows
            ]
            changes.append({
                "method_id": before.method_id,
                "status": "OK",
                "set_dependencies": list(next(m.set_dependencies for m in methods if m.method_id == before.method_id)),
                "changed_offer_count": sum(abs(item["delta"]) > 1e-9 for item in deltas),
                "mean_absolute_change": fmean(abs(item["delta"]) for item in deltas),
                "max_absolute_change": max(abs(item["delta"]) for item in deltas),
                "offer_changes": deltas,
            })
        return {
            "test_id": "ADD_EXTREME_OFFER_V1",
            "base_scenario": base_scenario.to_dict(),
            "new_offer": {"offer_id": new_offer_id, "price": float(new_offer)},
            "expanded_scenario": expanded.to_dict(),
            "changes": changes,
        }

    def _metrics(
        self,
        method: MethodDefinition,
        scenario: Scenario,
        result: SimulationResult,
    ) -> dict[str, Any]:
        by_price = sorted(result.rows, key=lambda row: row.price)
        scores = [row.score for row in result.rows]
        score_range = max(scores) - min(scores)
        consecutive = [
            abs(left.score - right.score) for left, right in zip(by_price, by_price[1:])
        ]
        slopes = [
            abs(left.score - right.score) / abs(left.price - right.price)
            for left, right in zip(by_price, by_price[1:])
            if left.price != right.price
        ]
        elasticities = [
            abs((left.score - right.score) / ((left.score + right.score) / 2.0))
            / abs((left.price - right.price) / ((left.price + right.price) / 2.0))
            for left, right in zip(by_price, by_price[1:])
            if left.price != right.price and (left.score + right.score) != 0
        ]
        monotonic = all(
            left.score + 1e-9 >= right.score for left, right in zip(by_price, by_price[1:])
        )
        return {
            "method_id": result.method_id,
            "parameters": dict(result.parameters),
            "effective_score_range": score_range,
            "effective_range_ratio": score_range / scenario.pmax,
            "score_stddev": pstdev(scores),
            "best_second_price_gap": by_price[1].price - by_price[0].price if len(by_price) > 1 else None,
            "best_second_score_gap": by_price[0].score - by_price[1].score if len(by_price) > 1 else None,
            "mean_consecutive_score_gap": fmean(consecutive) if consecutive else 0.0,
            "mean_local_sensitivity_points_per_euro": fmean(slopes) if slopes else 0.0,
            "mean_local_sensitivity_points_per_one_percent_pl": (
                fmean(slopes) * scenario.tender_price * 0.01 if slopes else 0.0
            ),
            "mean_absolute_elasticity": fmean(elasticities) if elasticities else None,
            "concentration": {
                "at_or_above_95pct_pmax": sum(row.score_normalized >= 0.95 for row in result.rows),
                "at_or_above_90pct_pmax": sum(row.score_normalized >= 0.90 for row in result.rows),
                "at_or_above_80pct_pmax": sum(row.score_normalized >= 0.80 for row in result.rows),
                "offer_count": len(result.rows),
            },
            "set_dependency": list(method.set_dependencies) or ["OWN_OFFER_AND_FIXED_PARAMETERS_ONLY"],
            "curvature": self._resolved_curvature(method, result.parameters),
            "monotonicity_expected": "MORE_DISCOUNT_NOT_LESS_SCORE",
            "monotonicity_pass": monotonic,
            "extreme_removal_influence": self._extreme_removal(method, scenario, result),
        }

    def _extreme_removal(
        self,
        method: MethodDefinition,
        scenario: Scenario,
        baseline: SimulationResult,
    ) -> dict[str, Any]:
        if len(scenario.offers) < 3:
            return {"status": "NOT_ENOUGH_OFFERS"}
        minimum_index = min(range(len(scenario.offers)), key=scenario.offers.__getitem__)
        reduced_offers = tuple(value for index, value in enumerate(scenario.offers) if index != minimum_index)
        ids = scenario.resolved_offer_ids()
        reduced_ids = tuple(value for index, value in enumerate(ids) if index != minimum_index)
        reduced = Scenario(
            scenario_id=f"{scenario.scenario_id}_WITHOUT_MINIMUM",
            label=f"{scenario.label} sin oferta mínima",
            tender_price=scenario.tender_price,
            pmax=scenario.pmax,
            offers=reduced_offers,
            offer_ids=reduced_ids,
        )
        result = self.simulation_engine.evaluate_scenario(method, reduced)
        if result.status != "SIMULATION_OK":
            return {"status": result.status, "errors": list(result.errors)}
        before = {row.offer_id: row.score for row in baseline.rows}
        deltas = [row.score - before[row.offer_id] for row in result.rows]
        return {
            "status": "OK",
            "removed_offer_id": ids[minimum_index],
            "changed_offer_count": sum(abs(value) > 1e-9 for value in deltas),
            "mean_absolute_change": fmean(abs(value) for value in deltas),
            "max_absolute_change": max(abs(value) for value in deltas),
        }

    @staticmethod
    def _resolved_curvature(method: MethodDefinition, parameters: dict[str, float]) -> str:
        if method.method_id == "NORMALIZED_PRICE_GAP_POWER":
            n = parameters["n"]
            return "LINEAR" if math.isclose(n, 1.0) else ("CONCAVE_IN_DISCOUNT" if n > 1 else "CONVEX_IN_DISCOUNT")
        if method.method_id == "DISCOUNT_MAX_POWER":
            n = parameters["n"]
            return "LINEAR" if math.isclose(n, 1.0) else ("CONVEX_IN_DISCOUNT" if n > 1 else "CONCAVE_IN_DISCOUNT")
        return method.curvature

    @staticmethod
    def _pairwise(simulations: Sequence[SimulationResult]) -> tuple[dict[str, Any], ...]:
        result: list[dict[str, Any]] = []
        for index, left in enumerate(simulations):
            left_scores = [row.score_normalized for row in left.rows]
            for right in simulations[index + 1 :]:
                right_scores = [row.score_normalized for row in right.rows]
                result.append({
                    "method_a": left.method_id,
                    "method_b": right.method_id,
                    "pearson_score_correlation": _pearson(left_scores, right_scores),
                    "normalized_rmse": math.sqrt(
                        fmean((a - b) ** 2 for a, b in zip(left_scores, right_scores))
                    ),
                    "max_normalized_score_difference": max(
                        abs(a - b) for a, b in zip(left_scores, right_scores)
                    ),
                })
        return tuple(result)

    @staticmethod
    def _ranking_summary(simulations: Sequence[SimulationResult]) -> dict[str, Any]:
        orders = {
            item.method_id: [row.offer_id for row in sorted(item.rows, key=lambda row: row.rank)]
            for item in simulations
        }
        unique_orders = {tuple(order) for order in orders.values()}
        return {
            "same_ranking_across_methods": len(unique_orders) <= 1,
            "distinct_rankings": len(unique_orders),
            "orders": orders,
            "interpretation": "Ranking and score spacing are measured separately.",
        }


def _pearson(left: Iterable[float], right: Iterable[float]) -> float | None:
    x = tuple(left)
    y = tuple(right)
    if len(x) != len(y) or len(x) < 2:
        return None
    mx, my = fmean(x), fmean(y)
    numerator = sum((a - mx) * (b - my) for a, b in zip(x, y))
    dx = math.sqrt(sum((a - mx) ** 2 for a in x))
    dy = math.sqrt(sum((b - my) ** 2 for b in y))
    if dx == 0 or dy == 0:
        return None
    return numerator / (dx * dy)
