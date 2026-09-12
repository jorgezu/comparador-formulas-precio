(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FormulaFormat = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const roundedKey = (value, decimals) => Number(value).toFixed(decimals);

  const decimalPlaces = (value) => {
    const text = Number(value).toString().toLowerCase();
    const [coefficient, exponentText = "0"] = text.split("e");
    const coefficientDecimals = (coefficient.split(".")[1] || "").length;
    return Math.max(0, coefficientDecimals - Number(exponentText));
  };

  const adaptiveDecimals = (values, minimum = 2, maximum = 4) => {
    const finite = values.map(Number).filter(Number.isFinite);
    for (let decimals = minimum; decimals <= maximum; decimals += 1) {
      let distinguishable = true;
      for (let left = 0; left < finite.length && distinguishable; left += 1) {
        for (let right = left + 1; right < finite.length; right += 1) {
          if (Math.abs(finite[left] - finite[right]) <= 1e-10) continue;
          if (roundedKey(finite[left], decimals) === roundedKey(finite[right], decimals)) {
            distinguishable = false;
            break;
          }
        }
      }
      if (distinguishable) {
        const significant = Math.max(...finite.map(decimalPlaces), minimum);
        return {
          decimals: decimals === minimum
            ? minimum
            : Math.min(maximum, Math.max(decimals, significant)),
          exceedsMaximum: false,
        };
      }
    }
    return {
      decimals: maximum,
      exceedsMaximum: finite.some((value, index) => finite.some(
        (other, otherIndex) => index !== otherIndex
          && Math.abs(value - other) > 1e-10
          && roundedKey(value, maximum) === roundedKey(other, maximum)
      )),
    };
  };

  const parameterText = (name, value) => {
    const numeric = Number(value);
    if (name === "n" && Math.abs(numeric - (1 / 6)) < 1e-9) return "1/6";
    return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 6 }).format(numeric);
  };

  return { adaptiveDecimals, parameterText };
}));
