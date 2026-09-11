"""Immutable records for deterministic formula-method simulations."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping


SIMULATION_VERSION = "FORMULA_METHOD_SIMULATION_V1"


@dataclass(frozen=True)
class MethodDefinition:
    method_id: str
    method_signature: str
    display_name: str
    expression: str
    parameters: Mapping[str, float]
    parameter_origin: str
    set_dependencies: tuple[str, ...]
    curvature: str
    sources: tuple[Mapping[str, Any], ...]
    status: str = "CONFIRMED"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    label: str
    tender_price: float
    pmax: float
    offers: tuple[float, ...]
    offer_ids: tuple[str, ...] = ()
    synthetic: bool = True
    description: str = ""

    def resolved_offer_ids(self) -> tuple[str, ...]:
        if self.offer_ids:
            return self.offer_ids
        return tuple(f"O{index:02d}" for index in range(1, len(self.offers) + 1))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OfferScore:
    offer_id: str
    price: float
    discount_amount: float
    discount_rate: float
    score: float
    score_normalized: float
    rank: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SimulationResult:
    simulation_version: str
    status: str
    method_id: str
    method_signature: str
    method_name: str
    expression: str
    parameters: Mapping[str, float]
    parameter_origin: str
    scenario: Mapping[str, Any]
    derived_variables: Mapping[str, float]
    rows: tuple[OfferScore, ...] = ()
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    traceability: tuple[Mapping[str, Any], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["rows"] = [row.to_dict() for row in self.rows]
        return value


@dataclass(frozen=True)
class ComparisonResult:
    simulation_version: str
    scenario: Mapping[str, Any]
    simulations: tuple[SimulationResult, ...]
    metrics: tuple[Mapping[str, Any], ...]
    pairwise_similarity: tuple[Mapping[str, Any], ...]
    ranking: Mapping[str, Any]
    errors: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "simulation_version": self.simulation_version,
            "scenario": dict(self.scenario),
            "simulations": [item.to_dict() for item in self.simulations],
            "metrics": [dict(item) for item in self.metrics],
            "pairwise_similarity": [dict(item) for item in self.pairwise_similarity],
            "ranking": dict(self.ranking),
            "errors": list(self.errors),
        }
