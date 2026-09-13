(() => {
  "use strict";

  const catalogNode = document.querySelector("#formula-catalog");
  if (!catalogNode || !window.FormulaFormat) return;

  const catalog = JSON.parse(catalogNode.textContent);
  const methods = new Map(catalog.methods.map((method) => [method.method_id, method]));
  const baseColors = ["#087f8c", "#c84556", "#3568b8", "#d08a16"];
  const svgNamespace = "http://www.w3.org/2000/svg";
  const percent = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const score = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const $ = (selector) => document.querySelector(selector);
  const nodes = {
    method: $("#lab-method"),
    methodList: $("#lab-method-list"),
    type: $("#lab-type"),
    title: $("#lab-title"),
    equation: $("#lab-equation"),
    family: $("#lab-family"),
    equivalenceGroup: $("#lab-equivalence-group"),
    equivalentForms: $("#lab-equivalent-forms"),
    offersForm: $("#lab-offers-form"),
    discountsForm: $("#lab-discounts-form"),
    equationOffers: $("#lab-equation-offers"),
    equationDiscounts: $("#lab-equation-discounts"),
    description: $("#lab-description"),
    controls: $("#lab-controls"),
    contractType: $("#lab-contract-type"),
    expectedBmax: $("#lab-expected-bmax"),
    expectedBmaxNumber: $("#lab-expected-bmax-number"),
    expectedBmaxValue: $("#lab-expected-bmax-value"),
    observedBmax: $("#lab-observed-bmax"),
    observedBmaxNumber: $("#lab-observed-bmax-number"),
    observedBmaxValue: $("#lab-observed-bmax-value"),
    showResultingCurve: $("#lab-show-resulting-curve"),
    status: $("#lab-status"),
    chart: $("#lab-chart"),
    legend: $("#lab-legend"),
    dependency: $("#lab-dependency"),
    dependencyCopy: $("#lab-dependency-copy"),
    zeroScore: $("#lab-zero-score"),
    zeroCopy: $("#lab-zero-copy"),
    particularities: $("#lab-particularities"),
    equivalences: $("#lab-equivalences"),
    equivalencesSection: $("#lab-equivalences-section"),
    specialCases: $("#lab-special-cases"),
    specialCasesSection: $("#lab-special-cases-section"),
    realCasesLink: $("#real-cases-link"),
    canonicalCards: $("#canonical-cards"),
  };

  let selectedMethodId = null;
  let customParameters = {};
  let requestSequence = 0;
  let expectedBmaxPct = 30;
  let observedBmaxPct = 20;

  const element = (name, className = "", text) => {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const svgElement = (name, attributes = {}) => {
    const node = document.createElementNS(svgNamespace, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };

  const evenlySpacedOffers = (maximumDiscountPct) => Array.from({ length: 20 }, (_, index) => {
    const discount = maximumDiscountPct * index / 19;
    return {
      offer_id: `theory-${index + 1}`,
      name: `B${index + 1}`,
      price: 100 * (1 - discount / 100),
    };
  });

  const naturalParameters = (parameters) => Object.entries(parameters).map(
    ([name, value]) => `${name} = ${window.FormulaFormat.parameterText(name, value)}`
  ).join(" · ");

  const selectedMethod = () => methods.get(selectedMethodId);

  const documentedSelection = (method, variant) => ({
    label: variant.label.replace(" · documentada", "").replace(" · caso lineal documentado", ""),
    selection: { method_id: method.method_id, variant_id: variant.variant_id },
    parameters: variant.parameters,
  });

  const seriesSelections = (method) => {
    if (!method.parameter_fields.length) {
      return [documentedSelection(method, method.variants[0])];
    }
    const variants = method.variants.length <= 3
      ? method.variants
      : [method.variants[0], method.variants[Math.floor(method.variants.length / 2)], method.variants.at(-1)];
    const series = variants.map((variant) => documentedSelection(method, variant));
    if (!series.some((item) => {
      const left = item.parameters;
      const right = customParameters;
      return Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every((key) => Math.abs(Number(left[key]) - Number(right[key])) < 1e-10);
    })) {
      series.push({
        label: `Ajuste actual · ${naturalParameters(customParameters)}`,
        selection: { method_id: method.method_id, variant_id: "custom", parameters: customParameters },
        parameters: customParameters,
      });
    }
    return series.slice(0, 4);
  };

  const requestCurve = async (series) => {
    const response = await fetch(catalog.api_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tender_price: 100,
        pmax: 100,
        offers: evenlySpacedOffers(observedBmaxPct),
        expected_maximum_discount_pct: expectedBmaxPct,
        methods: [series.selection],
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo calcular la curva.");
    return { ...series, result: payload, curve: payload.curves[0] };
  };

  const clearChart = () => {
    nodes.chart.querySelectorAll(":scope > :not(title):not(desc)").forEach((node) => node.remove());
  };

  const chartText = (x, y, text, anchor = "middle") => {
    const node = svgElement("text", { x, y, "text-anchor": anchor, class: "fp-chart-label" });
    node.textContent = text;
    nodes.chart.append(node);
  };

  const linePath = (points) => points.map(
    (point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)},${point[1].toFixed(2)}`
  ).join(" ");

  const drawChart = (series) => {
    clearChart();
    const width = 920;
    const height = 480;
    const margin = { left: 70, right: 24, top: 25, bottom: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const xMax = series[0].result.scenario.visual_maximum_discount_pct;
    const x = (value) => margin.left + value / xMax * plotWidth;
    const y = (value) => margin.top + plotHeight - value / 100 * plotHeight;
    for (let index = 0; index <= 5; index += 1) {
      const xValue = xMax * index / 5;
      const yValue = 100 * index / 5;
      nodes.chart.append(
        svgElement("line", { x1: x(xValue), y1: margin.top, x2: x(xValue), y2: margin.top + plotHeight, class: "fp-chart-grid" }),
        svgElement("line", { x1: margin.left, y1: y(yValue), x2: margin.left + plotWidth, y2: y(yValue), class: "fp-chart-grid" })
      );
      chartText(x(xValue), height - 32, `${percent.format(xValue)} %`);
      chartText(margin.left - 10, y(yValue) + 4, score.format(yValue), "end");
    }
    nodes.chart.append(
      svgElement("line", { x1: margin.left, y1: margin.top + plotHeight, x2: margin.left + plotWidth, y2: margin.top + plotHeight, class: "fp-chart-axis" }),
      svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotHeight, class: "fp-chart-axis" })
    );
    chartText(margin.left + plotWidth / 2, height - 5, "Baja teórica");
    const yLabel = svgElement("text", { x: 18, y: margin.top + plotHeight / 2, transform: `rotate(-90 18 ${margin.top + plotHeight / 2})`, "text-anchor": "middle", class: "fp-chart-label" });
    yLabel.textContent = "% de Pmax";
    nodes.chart.append(yLabel);
    series.forEach((item, index) => {
      const color = baseColors[index % baseColors.length];
      const points = [...item.curve.expected_points].sort((a, b) => a.discount_pct - b.discount_pct);
      const path = svgElement("path", {
        d: linePath(points.map((point) => [x(point.discount_pct), y(point.score_pct)])),
        class: "fp-chart-line",
      });
      path.style.setProperty("--series-color", color);
      nodes.chart.append(path);
      if (nodes.showResultingCurve.checked && !item.curve.curves_coincide) {
        const resulting = [...item.curve.resulting_points].sort((a, b) => a.discount_pct - b.discount_pct);
        const resultingPath = svgElement("path", {
          d: linePath(resulting.map((point) => [x(point.discount_pct), y(point.score_pct)])),
          class: "fp-chart-line is-resulting",
        });
        resultingPath.style.setProperty("--series-color", color);
        nodes.chart.append(resultingPath);
      }
      const zero = points.reduce((best, point) => Math.abs(point.discount_pct) < Math.abs(best.discount_pct) ? point : best, points[0]);
      const zeroPoint = svgElement("circle", { cx: x(zero.discount_pct), cy: y(zero.score_pct), r: 6, class: "fp-chart-point fp-zero-point" });
      zeroPoint.style.setProperty("--series-color", color);
      const title = svgElement("title");
      title.textContent = `${item.label}: ${score.format(zero.score_pct)} % de Pmax con baja 0 %`;
      zeroPoint.append(title);
      nodes.chart.append(zeroPoint);
    });
    nodes.legend.replaceChildren(...series.map((item, index) => {
      const legend = element("span", "fp-legend-item");
      legend.style.setProperty("--series-color", baseColors[index % baseColors.length]);
      legend.append(
        element("i", "fp-series-swatch"),
        element("span", "", `${item.label} · continua esperada${item.curve.curves_coincide ? " = resultante" : nodes.showResultingCurve.checked ? " · discontinua resultante" : ""}`)
      );
      return legend;
    }));
  };

  const renderTheoryNotes = (method, series) => {
    nodes.dependency.textContent = method.reference_type;
    nodes.dependencyCopy.textContent = method.depends_on_other_offers
      ? `${method.dependency}. Una oferta de un tercero puede desplazar la curva.`
      : `${method.dependency}. La misma baja permanece sobre la misma curva.`;
    const primary = series.at(-1);
    const zero = primary.curve.points.reduce(
      (best, point) => Math.abs(point.discount_pct) < Math.abs(best.discount_pct) ? point : best,
      primary.curve.points[0]
    );
    nodes.zeroScore.textContent = `${score.format(zero.score_pct)} % de Pmax`;
    nodes.zeroScore.classList.toggle("is-alert", zero.score_pct > 1e-8);
    nodes.zeroCopy.textContent = method.zero_discount_behavior;
    nodes.particularities.replaceChildren(...method.particularities.map((item) => element("li", "", item)));
    nodes.specialCasesSection.hidden = !method.special_cases.length;
    nodes.specialCases.replaceChildren(...method.special_cases.map((item) => element("li", "", item)));
    nodes.equivalencesSection.hidden = !method.verified_equivalences.length;
    nodes.equivalences.replaceChildren(...method.verified_equivalences.map((item) => element("li", "", item)));
  };

  const calculate = async () => {
    const sequence = ++requestSequence;
    const method = selectedMethod();
    nodes.status.textContent = "Calculando las curvas con el motor validado…";
    nodes.status.className = "fp-status is-loading";
    try {
      const series = await Promise.all(seriesSelections(method).map(requestCurve));
      if (sequence !== requestSequence) return;
      drawChart(series);
      renderTheoryNotes(method, series);
      nodes.status.textContent = `${series.length} curva${series.length === 1 ? "" : "s"} · baja máxima esperada ${percent.format(expectedBmaxPct)} % · observada ${percent.format(observedBmaxPct)} %`;
      nodes.status.className = "fp-status";
    } catch (error) {
      if (sequence !== requestSequence) return;
      nodes.status.textContent = error.message;
      nodes.status.className = "fp-status is-error";
    }
  };

  const scheduleCalculation = () => {
    window.clearTimeout(scheduleCalculation.timer);
    scheduleCalculation.timer = window.setTimeout(calculate, 180);
  };

  const syncBmaxControls = () => {
    nodes.expectedBmax.value = String(Math.min(95, Math.max(5, expectedBmaxPct)));
    nodes.expectedBmaxNumber.value = String(expectedBmaxPct);
    nodes.expectedBmaxValue.textContent = `${percent.format(expectedBmaxPct)} %`;
    nodes.observedBmax.value = String(observedBmaxPct);
    nodes.observedBmaxNumber.value = String(observedBmaxPct);
    nodes.observedBmaxValue.textContent = `${percent.format(observedBmaxPct)} %`;
  };

  const updateBmax = (kind, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) return;
    if (kind === "expected") expectedBmaxPct = value;
    else observedBmaxPct = value;
    syncBmaxControls();
    scheduleCalculation();
  };

  const renderControls = (method) => {
    if (!method.parameter_fields.length) {
      nodes.controls.replaceChildren(element("p", "fp-empty-copy", "Esta fórmula no tiene parámetros editables."));
      return;
    }
    nodes.controls.replaceChildren(...method.parameter_fields.map((field) => {
      const label = element("label", "fp-lab-control");
      const heading = element("span");
      const value = element("strong", "", window.FormulaFormat.parameterText(field.name, customParameters[field.name]));
      heading.append(element("span", "", field.label), value);
      const controls = element("div");
      const range = element("input");
      range.type = "range";
      range.min = String(field.min);
      range.max = String(field.max);
      range.step = String(field.step);
      range.value = String(Number(customParameters[field.name]) * Number(field.display_factor || 1));
      range.setAttribute("aria-label", field.label);
      const number = element("input");
      number.type = "number";
      number.min = String(field.min);
      number.max = String(field.max);
      number.step = String(field.step);
      number.value = range.value;
      number.setAttribute("aria-label", `${field.label} (valor)`);
      const update = (raw) => {
        const display = Number(raw);
        range.value = String(display);
        number.value = String(display);
        customParameters[field.name] = display / Number(field.display_factor || 1);
        value.textContent = window.FormulaFormat.parameterText(field.name, customParameters[field.name]);
        window.clearTimeout(update.timer);
        update.timer = window.setTimeout(calculate, 180);
      };
      range.addEventListener("input", () => update(range.value));
      number.addEventListener("input", () => update(number.value));
      controls.append(range, number);
      label.append(heading, controls);
      return label;
    }));
  };

  const renderMethod = () => {
    const method = selectedMethod();
    customParameters = { ...(method.variants.find((item) => item.variant_id === method.default_variant_id)?.parameters || {}) };
    nodes.method.value = method.method_id;
    nodes.type.textContent = method.reference_type;
    nodes.type.className = `fp-type-badge is-${method.reference_type.toLowerCase()}`;
    nodes.title.textContent = method.name;
    nodes.equation.innerHTML = method.equation_mathml;
    nodes.family.textContent = method.family;
    nodes.equivalenceGroup.textContent = method.equivalence_group;
    nodes.offersForm.hidden = !method.equation_offers_mathml;
    nodes.discountsForm.hidden = !method.equation_discounts_mathml;
    nodes.equationOffers.innerHTML = method.equation_offers_mathml || "";
    nodes.equationDiscounts.innerHTML = method.equation_discounts_mathml || "";
    nodes.equivalentForms.hidden = !(method.equation_offers_mathml && method.equation_discounts_mathml);
    nodes.description.textContent = method.description;
    nodes.realCasesLink.href = `${catalog.analyzer_url}?perfil=administracion&formula=${method.method_id}`;
    nodes.methodList.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.methodId === method.method_id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderControls(method);
    const url = new URL(window.location.href);
    url.hash = method.method_id;
    window.history.replaceState({}, "", url);
    calculate();
  };

  const selectMethod = (methodId) => {
    selectedMethodId = methods.has(methodId) ? methodId : catalog.methods[0].method_id;
    renderMethod();
  };

  const renderCanonicalCatalog = () => {
    nodes.canonicalCards.replaceChildren(...catalog.methods.map((method) => {
      const details = element("details", "fp-canonical-card");
      details.id = `catalog-${method.method_id}`;
      const summary = element("summary");
      summary.append(
        element("span", `fp-type-badge is-${method.reference_type.toLowerCase()}`, method.reference_type),
        element("strong", "", method.name)
      );
      const body = element("div", "fp-canonical-body");
      const equation = element("div", "fp-equation-display");
      equation.innerHTML = method.equation_mathml;
      body.append(
        element("p", "fp-canonical-family", `Familia: ${method.family}`),
        equation,
        element("p", "", method.description)
      );
      if (method.equation_offers_mathml && method.equation_discounts_mathml) {
        const forms = element("div", "fp-canonical-equivalents");
        const offers = element("div");
        offers.append(element("h4", "", "En ofertas"));
        const offersEquation = element("div", "fp-equation-display");
        offersEquation.innerHTML = method.equation_offers_mathml;
        offers.append(offersEquation);
        const discounts = element("div");
        discounts.append(element("h4", "", "En bajas"));
        const discountsEquation = element("div", "fp-equation-display");
        discountsEquation.innerHTML = method.equation_discounts_mathml;
        discounts.append(discountsEquation);
        forms.append(offers, discounts);
        body.append(element("h4", "", `Grupo de equivalencia · ${method.equivalence_group}`), forms);
      }
      if (method.special_cases.length) {
        body.append(element("h4", "", "Casos particulares"));
        const list = element("ul");
        list.append(...method.special_cases.map((item) => element("li", "", item)));
        body.append(list);
      }
      if (method.discrepancies.length) {
        body.append(element("h4", "", "Pendiente de validación documental"));
        const list = element("ul");
        list.append(...method.discrepancies.map((item) => element("li", "", item)));
        body.append(list);
      }
      details.append(summary, body);
      return details;
    }));
  };

  catalog.methods.forEach((method) => {
    const option = element("option", "", method.name);
    option.value = method.method_id;
    nodes.method.append(option);
    const button = element("button", "", method.short_name);
    button.type = "button";
    button.dataset.methodId = method.method_id;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => selectMethod(method.method_id));
    nodes.methodList.append(button);
  });
  nodes.method.addEventListener("change", () => selectMethod(nodes.method.value));
  nodes.contractType.addEventListener("change", () => {
    expectedBmaxPct = Number(catalog.theoretical_bmax_defaults[nodes.contractType.value]);
    syncBmaxControls();
    calculate();
  });
  nodes.expectedBmax.addEventListener("input", () => updateBmax("expected", nodes.expectedBmax.value));
  nodes.expectedBmaxNumber.addEventListener("input", () => updateBmax("expected", nodes.expectedBmaxNumber.value));
  nodes.observedBmax.addEventListener("input", () => updateBmax("observed", nodes.observedBmax.value));
  nodes.observedBmaxNumber.addEventListener("input", () => updateBmax("observed", nodes.observedBmaxNumber.value));
  nodes.showResultingCurve.addEventListener("change", calculate);
  syncBmaxControls();
  renderCanonicalCatalog();
  selectMethod(window.location.hash.slice(1));
})();
