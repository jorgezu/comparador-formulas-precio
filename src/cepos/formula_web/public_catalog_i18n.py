"""Locale-specific labels for the public catalogue; mathematical data stay shared."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


REFERENCE_TYPES_EN = {"Relativa": "Relative", "Absoluta": "Absolute", "Mixta": "Mixed"}
CASE_TYPES_EN = {"OBRAS": "WORKS", "SERVICIOS": "SERVICES", "SUMINISTROS": "SUPPLIES"}

METHODS_EN: dict[str, dict[str, Any]] = {
    "INVERSE_PRICE_PROPORTIONAL": {
        "name": "Inverse price proportional", "short_name": "Inverse",
        "description": "The lowest-priced bid receives the maximum score; all other bids are scored in inverse proportion to their price.",
        "family": "Inverse proportional", "dependency": "Lowest bid in the set, equivalent to the maximum price reduction",
        "behavior": "Convex curve with respect to the price reduction.", "zero_discount_behavior": "May be greater than zero; it depends on the lowest bid.",
        "equivalence_group": "Bid prices ↔ percentage reductions",
        "particularities": ["The score may change if a new lowest bid is submitted.", "A bid with no reduction may receive more than zero points."],
        "verified_equivalences": ["The bid-price and price-reduction forms are algebraically equivalent through O_i = PL · (1 - B_i/100)."],
    },
    "LINEAR_DISCOUNT_MAX": {
        "name": "Linear", "short_name": "Linear", "description": "Distributes points linearly between a zero reduction and the highest reduction submitted.",
        "family": "Relative linear", "dependency": "Maximum reduction in the bid set, equivalent to the lowest bid",
        "behavior": "Increasing straight line from zero to P_max.", "zero_discount_behavior": "Receives zero points.", "equivalence_group": "Bid prices ↔ relative reductions",
        "particularities": ["The slope changes when the maximum reduction changes.", "A third-party bid can alter every other bid's score."],
        "special_cases": ["Relative exponential with n = 1 → Linear.", "k-th root with k = 1 → Linear."],
        "verified_equivalences": ["The bid-price and price-reduction forms are algebraically equivalent."],
    },
    "AFFINE_MIN_REFERENCE_OVER_TENDER_PRICE": {
        "name": "Linear referenced to the lowest bid", "short_name": "Linear O_min",
        "description": "Deducts points according to the distance from the lowest bid, using the tender base price as the scale.",
        "family": "Relative affine linear", "dependency": "Lowest bid in the set, equivalent to the maximum price reduction",
        "behavior": "Straight line whose intercept depends on O_min.", "zero_discount_behavior": "P_i = P_max · [1 - (B_max/100)].", "equivalence_group": "Bid prices ↔ percentage reductions",
        "particularities": ["The lowest bid receives P_max.", "A bid with no reduction may start with a high score."],
        "special_cases": ["If B_i = 0, then P_i = P_max · [1 - (B_max/100)]."],
        "verified_equivalences": ["Substituting O = PL · (1 - B/100) exactly reproduces the implementation."],
        "discrepancies": ["This formulation was not found in the main slides or columns of the reviewed workbook."],
    },
    "NORMALIZED_PRICE_GAP_POWER": {
        "name": "Relative exponential", "short_name": "Relative exp.",
        "description": "Exponent n changes the concavity and how quickly scores become concentrated near the maximum.",
        "family": "Normalised relative power", "dependency": "Maximum reduction in the bid set, equivalent to the lowest bid",
        "behavior": "Linear when n = 1; when n > 1, more points are concentrated at moderate reductions.", "zero_discount_behavior": "Receives zero points.", "equivalence_group": "Bid prices ↔ relative reductions",
        "particularities": ["The entire curve changes when the maximum reduction changes.", "The n = B_max/5 variant uses B_max in percentage points."],
        "special_cases": ["n = 1 → Linear.", "n = B_max/5 → self-adjusting variant of this formula."],
        "verified_equivalences": ["The bid-price and price-reduction forms are equivalent.", "When n = 1 it is identical to Linear."],
        "discrepancies": ["The source documentation calls it exponential, although its mathematical implementation is a power with exponent n."],
        "parameter_labels": {"n": "Exponent n"},
        "variant_labels": {"documented-1": "n = 1 · documented linear case", "documented-2": "n = 3 · documented", "documented-3": "n = 5 · documented", "documented-4": "n = 6 · documented", "documented-5": "n = 10 · documented", "bmax-over-5": "n = Bmax / 5 · self-adjusting"},
    },
    "DISCOUNT_MAX_POWER": {
        "name": "k-th root", "short_name": "k-th root", "description": "Index k directly expresses the root applied to the relative price reduction.",
        "family": "Normalised relative power", "dependency": "Maximum reduction in the bid set, equivalent to the lowest bid",
        "behavior": "Concave when k > 1; linear when k = 1.", "zero_discount_behavior": "Receives zero points.", "equivalence_group": "Bid prices ↔ relative reductions",
        "particularities": ["The documented variant is the sixth root: k = 6.", "The full scale changes if the maximum reduction changes."],
        "special_cases": ["k = 1 → Linear.", "Internal relationship: n = 1/k."],
        "verified_equivalences": ["The bid-price and price-reduction forms are equivalent.", "When k = 1 it is identical to Linear."],
        "parameter_labels": {"k": "Root index k"}, "variant_labels": {"documented-1": "k = 6 · documented"},
    },
    "EXPONENTIAL_SATURATING_DISCOUNT": {
        "name": "Saturating exponential", "short_name": "Saturating exp.",
        "description": "The score increases with the price reduction and progressively approaches P_max without depending on other bids.",
        "family": "Absolute exponential", "dependency": "Only reduction B_i and parameter k",
        "behavior": "Concave, saturating curve.", "zero_discount_behavior": "Receives zero points.", "equivalence_group": "Bid prices ↔ percentage reduction",
        "particularities": ["The expected and resulting curves coincide.", "Parameter k uses B_i expressed in percentage points."],
        "special_cases": ["For the same B_i, the score does not change with third-party bids."],
        "verified_equivalences": ["The internal factor 100 converts the engine's fractional reduction into the public percentage B_i."],
        "parameter_labels": {"k": "Coefficient k"}, "variant_labels": {"documented-1": "k = 0.25 · documented", "documented-2": "k = 0.3 · documented"},
    },
    "DISCOUNT_THRESHOLD_TWO_SEGMENTS": {
        "name": "Two-segment saturation threshold", "short_name": "Two segments",
        "description": "Applies an initial slope up to a threshold, then distributes the remaining points up to the observed maximum reduction.",
        "family": "Piecewise linear", "dependency": "Fixed threshold B in the first segment and maximum reduction in the second",
        "behavior": "Two continuous straight lines with different slopes, scaled to the scenario P_max.", "zero_discount_behavior": "Receives zero points.", "equivalence_group": "Piecewise percentage expression",
        "particularities": ["B_i, B and B_max are expressed in percentage points.", "Factor s adapts n and k to P_max."],
        "special_cases": ["The first segment does not depend on the maximum reduction; the second does."],
        "verified_equivalences": ["In the engine: n = first_slope, B = 100·threshold and k = tail_points; s = P_max/(n·B+k)."],
        "discrepancies": ["The source presentation groups it with absolute formulas, but the second segment depends on B_max and the implementation is classified as mixed."],
        "parameter_labels": {"n": "Initial slope n", "B": "Reduction threshold B", "k": "Final-segment points k"},
    },
    "MEDIAN_NORMALIZED_EXPONENTIAL": {
        "name": "Median-normalised exponential", "short_name": "Median normalised exp.",
        "description": "Normalises an exponential curve so that the maximum reduction receives P_max, using the median reduction to modulate its shape.",
        "family": "Relative normalised exponential", "dependency": "Maximum and median reductions in the bid set",
        "behavior": "Increasing, concave exponential curve normalised at B_max.", "zero_discount_behavior": "Receives zero points when B_i = 0 and B_max > 0.", "equivalence_group": "Median-conditioned price-reduction expression",
        "particularities": ["The expected curve uses theoretical B_max and retains the observed B_mdn.", "The resulting curve uses observed B_max and B_mdn.", "k = 0.468 is the initial value and can be changed."],
        "special_cases": ["If B_max = 0, the formula cannot be evaluated.", "If B_mdn = 0 while B_max is positive, the formula is undefined.", "With an even number of bids, B_mdn is the mean of the two central values."],
        "verified_equivalences": ["B_i, B_max and B_mdn use a homogeneous scale; their ratios are dimensionless."], "parameter_labels": {"k": "Coefficient k"},
    },
    "MEDIAN_QUADRATIC_RATIONAL": {
        "name": "Median-based quadratic rational", "short_name": "Median quadratic rational",
        "description": "Combines quadratic terms for the individual, maximum and median reductions to retain discrimination between close bids.",
        "family": "Relative quadratic rational", "dependency": "Maximum and median reductions in the bid set",
        "behavior": "Increasing quadratic rational curve normalised at B_max.", "zero_discount_behavior": "Receives zero points when B_i = 0 and B_max > 0.", "equivalence_group": "Median-conditioned price-reduction expression",
        "particularities": ["The expected curve uses theoretical B_max and retains the observed B_mdn.", "The resulting curve uses observed B_max and B_mdn.", "k = 0.383 is the initial value and can be changed."],
        "special_cases": ["If B_max = 0, the formula cannot be evaluated.", "If B_mdn = 0 while B_max is positive, the formula is undefined.", "With an even number of bids, B_mdn is the mean of the two central values."],
        "verified_equivalences": ["B_i, B_max and B_mdn use a homogeneous scale; the quotients are dimensionless."], "parameter_labels": {"k": "Coefficient k"},
    },
}


def localise_catalog(catalog: dict[str, Any], locale: str) -> dict[str, Any]:
    result = deepcopy(catalog)
    if locale != "en":
        return result
    result["title"] = "TenderLab · Economic scoring formulas in Spain"
    for method in result.get("methods", []):
        updates = METHODS_EN.get(method["method_id"], {})
        method["reference_type_class"] = method.get("reference_type", "").casefold()
        for key, value in updates.items():
            if key not in {"parameter_labels", "variant_labels"}:
                method[key] = deepcopy(value)
        method["reference_type"] = REFERENCE_TYPES_EN.get(method.get("reference_type"), method.get("reference_type"))
        parameter_labels = updates.get("parameter_labels", {})
        for field in method.get("parameter_fields", []):
            field["label"] = parameter_labels.get(field["name"], field["label"])
        variant_labels = updates.get("variant_labels", {})
        for variant in method.get("variants", []):
            variant["label"] = variant_labels.get(variant["variant_id"], variant["label"].replace("documentada", "documented").replace("Configuración confirmada", "Confirmed configuration"))
    for case in result.get("cases", []):
        number = case["case_id"].split("-")[-1]
        case["label"] = f"Case {number} · {CASE_TYPES_EN.get(case['contract_type'], case['contract_type'])}"
        case["note"] = "Real case based on a completed Spanish public tender. Economic data and outcomes are preserved; identifying details of the procedure and bidders are omitted."
    return result
