"""Local deterministic simulation of normalized formula methods."""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    "ComparisonResult",
    "FormulaComparisonEngine",
    "FormulaMethodCatalog",
    "FormulaSimulationEngine",
    "MethodDefinition",
    "OfferScore",
    "Scenario",
    "SimulationResult",
    "SIMULATION_VERSION",
]

_EXPORT_MODULES = {
    "FormulaMethodCatalog": ".catalog",
    "FormulaComparisonEngine": ".comparison",
    "FormulaSimulationEngine": ".engine",
    "ComparisonResult": ".models",
    "MethodDefinition": ".models",
    "OfferScore": ".models",
    "Scenario": ".models",
    "SimulationResult": ".models",
    "SIMULATION_VERSION": ".models",
}


def __getattr__(name: str) -> Any:
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(name)
    return getattr(import_module(module_name, __name__), name)
