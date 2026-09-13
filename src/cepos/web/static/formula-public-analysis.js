(() => {
  "use strict";

  const catalogNode = document.querySelector("#formula-catalog");
  if (!catalogNode || !window.FormulaFormat) return;

  const catalog = JSON.parse(catalogNode.textContent);
  const colors = ["#087f8c", "#c84556", "#3568b8", "#d08a16", "#3d7f58", "#785c99", "#8b5a3c"];
  const colorByMethod = new Map(catalog.methods.map((method, index) => [method.method_id, colors[index]]));
  const euro = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const summaryNumber = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const svgNamespace = "http://www.w3.org/2000/svg";
  const $ = (selector) => document.querySelector(selector);
  const deepCopy = (value) => JSON.parse(JSON.stringify(value));

  const nodes = {
    caseSelector: $("#case-selector"),
    caseTitle: $("#case-title"),
    caseStripFacts: $("#case-strip-facts"),
    caseNote: $("#case-note"),
    scenarioGuidance: $("#scenario-guidance"),
    resultStatus: $("#result-status"),
    methodList: $("#method-list"),
    methodCount: $("#method-count"),
    parameterList: $("#parameter-list"),
    offerList: $("#offer-list"),
    offerCount: $("#offer-count"),
    tenderPrice: $("#tender-price"),
    pmax: $("#pmax"),
    expectedBmax: $("#expected-bmax"),
    expectedBmaxNumber: $("#expected-bmax-number"),
    expectedBmaxValue: $("#expected-bmax-value"),
    bmaxInlineComparison: $("#bmax-inline-comparison"),
    bmaxSummary: $("#bmax-summary"),
    showResultingCurve: $("#show-resulting-curve"),
    impactSummary: $("#impact-summary"),
    chart: $("#result-chart"),
    chartLegend: $("#chart-legend"),
    chartOffers: $("#chart-offers"),
    selectedOffer: $("#selected-offer"),
    rankingFormula: $("#ranking-formula"),
    simulatedWinner: $("#simulated-winner"),
    winnerFormulaLabel: $("#winner-formula-label"),
    baselineCompare: $("#baseline-compare"),
    technicalBest: $("#technical-best"),
    cheapestOffer: $("#cheapest-offer"),
    rankingList: $("#ranking-list"),
    scoreSpread: $("#score-spread"),
    caseDataBody: $("#case-data-body"),
    scoresHead: $("#scores-head"),
    scoresBody: $("#scores-body"),
    precisionNote: $("#precision-note"),
    conclusionList: $("#conclusion-list"),
    understandFormulaLink: $("#understand-formula-link"),
    commercialTitle: $("#commercial-cta-title"),
    commercialCopy: $("#commercial-cta-copy"),
  };

  let currentCase = null;
  let offers = [];
  let baseline = null;
  let methodState = new Map();
  let lastResult = null;
  let rankingMode = "price";
  let rankingMethodId = null;
  let selectedOfferId = null;
  let expectedBmaxPct = 30;
  let debounceTimer = null;
  let requestController = null;
  let offerSequence = 20;
  let profile = new URLSearchParams(window.location.search).get("perfil") === "empresa"
    ? "empresa"
    : "administracion";

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

  const setStatus = (message, kind = "ready") => {
    nodes.resultStatus.textContent = message;
    nodes.resultStatus.classList.toggle("is-error", kind === "error");
    nodes.resultStatus.classList.toggle("is-loading", kind === "loading");
  };

  const currentScenario = () => ({
    tender_price: Number(nodes.tenderPrice.value),
    pmax: Number(nodes.pmax.value),
    offers: offers
      .filter((offer) => !offer.excluded)
      .map(({ offer_id, name, price }) => ({ offer_id, name, price })),
  });

  const initialBmaxForCase = (selectedCase) => Number(
    catalog.theoretical_bmax_defaults[selectedCase.contract_type] || 30
  );

  const nonPricePoints = (offerId) => Number(
    offers.find((offer) => offer.offer_id === offerId)?.non_price_points || 0
  );

  const scenariosMatch = () => baseline
    && JSON.stringify(baseline) === JSON.stringify(currentScenario());

  const sameParameters = (left, right) => {
    const leftKeys = Object.keys(left || {});
    return leftKeys.length === Object.keys(right || {}).length
      && leftKeys.every((key) => Math.abs(Number(left[key]) - Number(right[key])) < 1e-10);
  };

  const defaultStateForCase = (selectedCase) => {
    const requestedFormula = new URLSearchParams(window.location.search).get("formula");
    const preferred = [
      selectedCase.actual_formula_supported ? selectedCase.actual_method_id : null,
      requestedFormula,
      "LINEAR_DISCOUNT_MAX",
      "NORMALIZED_PRICE_GAP_POWER",
      "EXPONENTIAL_SATURATING_DISCOUNT",
      "DISCOUNT_MAX_POWER",
    ].filter(Boolean);
    const selectedIds = [...new Set(preferred)].slice(0, 4);
    const state = new Map();
    catalog.methods.forEach((method) => {
      const variant = method.variants.find((item) => item.variant_id === method.default_variant_id)
        || method.variants[0];
      state.set(method.method_id, {
        selected: selectedIds.includes(method.method_id),
        variant_id: variant.variant_id,
        parameters: deepCopy(variant.parameters),
      });
    });
    if (selectedCase.actual_formula_supported) {
      const method = catalog.methods.find((item) => item.method_id === selectedCase.actual_method_id);
      const variant = method?.variants.find((item) => sameParameters(item.parameters, selectedCase.actual_parameters));
      state.set(selectedCase.actual_method_id, {
        selected: true,
        variant_id: variant?.variant_id || "custom",
        parameters: deepCopy(selectedCase.actual_parameters),
      });
    }
    return state;
  };

  const activeMethods = () => catalog.methods.filter(
    (method) => methodState.get(method.method_id)?.selected
  );

  const selectedMethodsPayload = () => activeMethods().map((method) => {
    const state = methodState.get(method.method_id);
    const selection = { method_id: method.method_id, variant_id: state.variant_id };
    if (state.variant_id === "custom") selection.parameters = state.parameters;
    return selection;
  });

  const renderProfile = () => {
    document.querySelectorAll("#profile-selector [data-profile]").forEach((button) => {
      const active = button.dataset.profile === profile;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const copy = profile === "empresa"
      ? {
          guidance: "Prueba una baja asumible y observa su posición sin convertir el resultado en una recomendación automática.",
          title: "¿Necesitas un análisis completo antes de presentar tu oferta?",
          cta: "El análisis profesional puede incorporar costes, capacidades reales y distintos escenarios de competencia.",
        }
      : {
          guidance: "Cambia una fórmula, un parámetro o una oferta y observa el efecto sin perder de vista la gráfica.",
          title: "¿Quieres analizar tu propia licitación?",
          cta: "El análisis profesional puede comparar fórmulas, justificar parámetros y documentar su comportamiento sobre ofertas reales.",
    };
    nodes.scenarioGuidance.textContent = copy.guidance;
    if (nodes.commercialTitle && nodes.commercialCopy) {
      nodes.commercialTitle.textContent = copy.title;
      nodes.commercialCopy.textContent = copy.cta;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("perfil", profile);
    window.history.replaceState({}, "", url);
    if (lastResult) renderConclusions(lastResult);
  };

  const populateCases = () => {
    const groups = ["SUMINISTROS", "OBRAS", "SERVICIOS"];
    nodes.caseSelector.replaceChildren(...groups.map((type) => {
      const group = element("optgroup");
      group.label = type.charAt(0) + type.slice(1).toLowerCase();
      catalog.cases.filter((item) => item.contract_type === type).forEach((item) => {
        const option = element("option", "", item.label);
        option.value = item.case_id;
        group.append(option);
      });
      return group;
    }));
  };

  const stripFact = (label, value, accent = false) => {
    const item = element("div", accent ? "is-accent" : "");
    item.append(element("span", "", label), element("strong", "", value));
    return item;
  };

  const renderCaseStrip = () => {
    const actualMethod = catalog.methods.find(
      (method) => method.method_id === currentCase.actual_method_id
    );
    nodes.caseTitle.textContent = currentCase.label;
    nodes.caseNote.textContent = currentCase.note;
    nodes.caseStripFacts.replaceChildren(
      stripFact("Tipo", currentCase.contract_type),
      stripFact("Precio de licitación", euro.format(currentCase.tender_price)),
      stripFact("Puntos precio", summaryNumber.format(currentCase.pmax)),
      stripFact("Ofertas", String(currentCase.offers.length)),
      stripFact("Fórmula real", actualMethod?.name || currentCase.actual_method_name),
      stripFact("Adjudicatario real", currentCase.actual_awardee, true)
    );
  };

  const loadCase = (caseId) => {
    currentCase = deepCopy(catalog.cases.find((item) => item.case_id === caseId) || catalog.cases[0]);
    nodes.caseSelector.value = currentCase.case_id;
    nodes.tenderPrice.value = String(currentCase.tender_price);
    nodes.pmax.value = String(currentCase.pmax);
    expectedBmaxPct = initialBmaxForCase(currentCase);
    nodes.expectedBmax.value = String(expectedBmaxPct);
    nodes.expectedBmaxNumber.value = String(expectedBmaxPct);
    offers = currentCase.offers.map((offer) => ({
      offer_id: offer.offer_id,
      name: offer.name,
      price: offer.price,
      non_price_points: offer.non_price_points,
      excluded: false,
    }));
    baseline = deepCopy(currentScenario());
    methodState = defaultStateForCase(currentCase);
    rankingMethodId = currentCase.actual_formula_supported ? currentCase.actual_method_id : null;
    selectedOfferId = null;
    renderCaseStrip();
    renderBmaxControl();
    renderMethodList();
    renderParameters();
    renderOffers();
    scheduleCompare(0);
  };

  const signedPp = (value) => `${value >= 0 ? "+" : "−"}${percent.format(Math.abs(value))} p.p.`;

  const observedBmax = () => {
    const tenderPrice = Number(nodes.tenderPrice.value);
    return Math.max(...offers.filter((offer) => !offer.excluded).map(
      (offer) => (tenderPrice - offer.price) / tenderPrice * 100
    ));
  };

  const renderBmaxControl = (result = null) => {
    const observed = result?.scenario.maximum_discount_pct ?? observedBmax();
    nodes.expectedBmaxValue.textContent = `${summaryNumber.format(expectedBmaxPct)} %`;
    nodes.bmaxInlineComparison.textContent = `Esperada ${summaryNumber.format(expectedBmaxPct)} % → observada ${percent.format(observed)} %`;
    nodes.bmaxSummary.replaceChildren(
      element("span", "", `Bmax esperada: ${summaryNumber.format(expectedBmaxPct)} %`),
      element("span", "", `Bmax real: ${percent.format(observed)} %`),
      element("strong", "", `Diferencia: ${signedPp(observed - expectedBmaxPct)}`)
    );
  };

  const equationDetails = (method) => {
    const details = element("details", "fp-equation-popover");
    const summary = element("summary");
    summary.setAttribute("aria-label", `Ver ecuación de ${method.name}`);
    summary.title = `Ver ecuación de ${method.name}`;
    summary.textContent = "i";
    const body = element("div", "fp-equation-popover-body");
    body.append(element("h3", "", method.name));
    const equation = element("div", "fp-equation-inline");
    equation.innerHTML = method.equation_mathml;
    body.append(
      equation,
      element("strong", "", `${method.reference_type} · ${method.dependency}`)
    );
    if (method.equation_offers_plain && method.equation_discounts_plain) {
      body.append(element("p", "fp-equivalent-note", "También tiene una forma equivalente: misma fórmula, distintas variables."));
    }
    if (method.special_cases.length) {
      body.append(element("p", "fp-special-case-note", method.special_cases[0]));
    }
    const labLink = element("a", "fp-popover-link", "Ver en el Laboratorio");
    labLink.href = `${catalog.lab_url}#${method.method_id}`;
    body.append(labLink);
    details.append(summary, body);
    return details;
  };

  const renderMethodList = () => {
    nodes.methodList.replaceChildren(...catalog.methods.map((method) => {
      const state = methodState.get(method.method_id);
      const row = element("div", `fp-method-choice${state.selected ? " is-active" : ""}`);
      row.style.setProperty("--series-color", colorByMethod.get(method.method_id));
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected;
      checkbox.setAttribute("aria-label", `Mostrar ${method.name}`);
      checkbox.addEventListener("change", () => {
        state.selected = checkbox.checked;
        if (!activeMethods().length) {
          state.selected = true;
          checkbox.checked = true;
          setStatus("Debe permanecer visible al menos una fórmula.", "error");
          return;
        }
        if (!rankingMethodId || !methodState.get(rankingMethodId)?.selected) {
          rankingMethodId = activeMethods()[0].method_id;
        }
        renderMethodList();
        renderParameters();
        scheduleCompare(0);
      });
      label.append(
        checkbox,
        element("i", "fp-series-swatch"),
        element("span", "", method.name)
      );
      row.append(label, equationDetails(method));
      return row;
    }));
    nodes.methodCount.textContent = `${activeMethods().length}/${catalog.methods.length}`;
  };

  const renderParameters = () => {
    const parameterized = activeMethods().filter((method) => method.parameter_fields.length);
    if (!parameterized.length) {
      nodes.parameterList.replaceChildren(element("p", "fp-empty-copy", "Las fórmulas activas no tienen parámetros editables."));
      return;
    }
    nodes.parameterList.replaceChildren(...parameterized.map((method) => {
      const state = methodState.get(method.method_id);
      const group = element("div", "fp-parameter-group");
      group.style.setProperty("--series-color", colorByMethod.get(method.method_id));
      group.append(element("strong", "", method.name));
      const variant = element("select");
      variant.setAttribute("aria-label", `Configuración de ${method.name}`);
      method.variants.forEach((item) => {
        const option = element("option", "", item.label);
        option.value = item.variant_id;
        variant.append(option);
      });
      const custom = element("option", "", "Valores personalizados");
      custom.value = "custom";
      variant.append(custom);
      variant.value = state.variant_id;
      variant.addEventListener("change", () => {
        state.variant_id = variant.value;
        if (variant.value !== "custom") {
          const chosen = method.variants.find((item) => item.variant_id === variant.value);
          state.parameters = deepCopy(chosen.parameters);
        } else {
          const fallback = method.variants.find((item) => !item.dynamic)?.parameters || {};
          method.parameter_fields.forEach((field) => {
            if (!Number.isFinite(Number(state.parameters[field.name]))) {
              state.parameters[field.name] = fallback[field.name];
            }
          });
        }
        renderParameters();
        scheduleCompare(0);
      });
      group.append(variant);
      const selectedVariant = method.variants.find((item) => item.variant_id === state.variant_id);
      if (selectedVariant?.dynamic) {
        group.append(element(
          "p",
          "fp-parameter-derived",
          `n se calcula automáticamente: Bmax esperada ${summaryNumber.format(expectedBmaxPct)} % → n = ${summaryNumber.format(expectedBmaxPct / 5)}; Bmax real ${summaryNumber.format(observedBmax())} % → n = ${summaryNumber.format(observedBmax() / 5)}.`
        ));
        return group;
      }
      method.parameter_fields.forEach((field) => {
        const label = element("label", "fp-parameter-field");
        const heading = element("span");
        heading.append(
          element("span", "", field.label),
          element("strong", "", window.FormulaFormat.parameterText(field.name, state.parameters[field.name]))
        );
        const input = element("input");
        input.type = "number";
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step);
        input.value = String(Number(state.parameters[field.name]) * Number(field.display_factor || 1));
        input.setAttribute("aria-label", `${field.label} de ${method.name}`);
        input.addEventListener("input", () => {
          state.variant_id = "custom";
          state.parameters[field.name] = Number(input.value) / Number(field.display_factor || 1);
          heading.lastElementChild.textContent = window.FormulaFormat.parameterText(
            field.name,
            state.parameters[field.name]
          );
          variant.value = "custom";
          scheduleCompare();
        });
        label.append(heading, input);
        group.append(label);
      });
      return group;
    }));
  };

  const renderOffers = () => {
    const activeCount = offers.filter((offer) => !offer.excluded).length;
    nodes.offerCount.textContent = `${activeCount}/${offers.length}`;
    nodes.offerList.replaceChildren(...offers.map((offer) => {
      const row = element("div", `fp-offer-row${offer.excluded ? " is-excluded" : ""}`);
      const name = element("strong", "", offer.name);
      const input = element("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.min = "0.01";
      input.step = "1000";
      input.value = String(offer.price);
      input.disabled = offer.excluded;
      input.setAttribute("aria-label", `Importe de ${offer.name}`);
      input.addEventListener("input", () => {
        offer.price = Number(input.value);
        scheduleCompare();
      });
      const toggle = element("button", "fp-icon-button", offer.excluded ? "↺" : "×");
      toggle.type = "button";
      toggle.title = offer.excluded ? `Restaurar ${offer.name}` : `Excluir ${offer.name}`;
      toggle.setAttribute("aria-label", toggle.title);
      toggle.addEventListener("click", () => {
        if (!offer.excluded && activeCount <= 2) {
          setStatus("Deben quedar al menos dos ofertas activas.", "error");
          return;
        }
        offer.excluded = !offer.excluded;
        if (offer.excluded && selectedOfferId === offer.offer_id) selectedOfferId = null;
        renderOffers();
        scheduleCompare(0);
      });
      row.append(name, input, toggle);
      return row;
    }));
  };

  const scheduleCompare = (delay = 250) => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(compareNow, delay);
  };

  const compareNow = async () => {
    const methods = selectedMethodsPayload();
    if (!methods.length) return;
    if (requestController) requestController.abort();
    requestController = new AbortController();
    setStatus("Actualizando curvas y clasificación…", "loading");
    try {
      const response = await fetch(catalog.api_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...currentScenario(),
          expected_maximum_discount_pct: expectedBmaxPct,
          methods,
          baseline,
        }),
        signal: requestController.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "No se pudo calcular el escenario.");
      lastResult = result;
      renderResult(result);
      setStatus(`${result.scenario.offer_count} ofertas · ${result.methods.length} fórmulas · actualizado`);
    } catch (error) {
      if (error.name !== "AbortError") setStatus(error.message, "error");
    }
  };

  const scoreDecimals = (result) => new Map(result.methods.map((method) => [
    method.method_id,
    window.FormulaFormat.adaptiveDecimals(
      result.rows.map((row) => row.scores[method.method_id]),
      2,
      4
    ),
  ]));

  const formatScore = (value, decimals) => new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);

  const rankedRows = (result, methodId, mode) => result.rows
    .map((row) => ({
      ...row,
      value: Number(row.scores[methodId]) + (mode === "total" ? nonPricePoints(row.offer_id) : 0),
    }))
    .sort((left, right) => right.value - left.value || left.price - right.price || left.name.localeCompare(right.name));

  const currentMethod = (result) => result.methods.find(
    (method) => method.method_id === rankingMethodId
  ) || result.methods[0];

  const renderRankingFormula = (result) => {
    const previous = rankingMethodId;
    nodes.rankingFormula.replaceChildren(...result.methods.map((method) => {
      const option = element("option", "", method.name);
      option.value = method.method_id;
      return option;
    }));
    rankingMethodId = result.methods.some((method) => method.method_id === previous)
      ? previous
      : result.methods[0].method_id;
    nodes.rankingFormula.value = rankingMethodId;
    nodes.understandFormulaLink.href = `${catalog.lab_url}#${rankingMethodId}`;
  };

  const renderPermanentResults = (result) => {
    const method = currentMethod(result);
    const ranking = rankedRows(result, method.method_id, rankingMode);
    const precision = window.FormulaFormat.adaptiveDecimals(ranking.map((row) => row.value), 2, 4).decimals;
    const winner = ranking[0];
    nodes.simulatedWinner.textContent = winner?.name || "—";
    nodes.winnerFormulaLabel.textContent = `${method.name} · ${rankingMode === "total" ? "precio + puntos NO precio" : "sólo precio"}`;
    nodes.baselineCompare.className = `fp-baseline-compare${winner?.name === currentCase.actual_awardee ? " is-same" : " is-changed"}`;
    nodes.baselineCompare.replaceChildren(
      element("span", "", `Adjudicatario real: ${currentCase.actual_awardee}`),
      element(
        "strong",
        "",
        winner?.name === currentCase.actual_awardee
          ? "El ganador no cambia."
          : `La simulación sitúa primero a ${winner?.name}.`
      )
    );
    const activeOffers = offers.filter((offer) => !offer.excluded);
    const technical = [...activeOffers].sort((a, b) => b.non_price_points - a.non_price_points || a.price - b.price)[0];
    const cheapest = [...activeOffers].sort((a, b) => a.price - b.price)[0];
    nodes.technicalBest.textContent = technical?.name || "—";
    nodes.cheapestOffer.textContent = cheapest?.name || "—";
    nodes.rankingList.replaceChildren(...ranking.slice(0, 8).map((row, index) => {
      const item = element("li", [
        row.name === currentCase.actual_awardee ? "is-real-awardee" : "",
        index === 0 ? "is-simulated-winner" : "",
        row.name === technical?.name ? "is-technical" : "",
        row.name === cheapest?.name ? "is-cheapest" : "",
      ].filter(Boolean).join(" "));
      const place = element("span", "fp-rank-place", String(index + 1));
      const identity = element("span", "fp-rank-identity");
      identity.append(element("strong", "", row.name));
      const tags = [];
      if (row.name === currentCase.actual_awardee) tags.push("real");
      if (row.name === technical?.name) tags.push("técnica");
      if (row.name === cheapest?.name) tags.push("económica");
      if (tags.length) identity.append(element("small", "", tags.join(" · ")));
      item.append(place, identity, element("strong", "fp-rank-score", formatScore(row.value, precision)));
      return item;
    }));
    const values = ranking.map((row) => row.value);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    nodes.scoreSpread.textContent = `Las ofertas quedan entre ${summaryNumber.format(minimum)} y ${summaryNumber.format(maximum)} puntos. ${summaryNumber.format(maximum - minimum)} puntos separan la menor y la mayor puntuación.`;
  };

  const renderImpact = (result) => {
    if (scenariosMatch()) {
      nodes.impactSummary.textContent = "Estás viendo la configuración real del caso.";
      return;
    }
    const impact = result.impacts.find((item) => item.method_id === rankingMethodId) || result.impacts[0];
    if (!impact) {
      nodes.impactSummary.textContent = "La simulación difiere del caso real.";
      return;
    }
    nodes.impactSummary.textContent = impact.unchanged_price_changed_count
      ? `${impact.unchanged_price_changed_count} ofertas cambian de puntuación aunque su importe no se haya modificado.`
      : "Las ofertas con el mismo importe conservan su puntuación.";
  };

  const clearChart = () => {
    nodes.chart.querySelectorAll(":scope > :not(title):not(desc)").forEach((node) => node.remove());
  };

  const chartText = (x, y, value, anchor = "middle", className = "fp-chart-label") => {
    const text = svgElement("text", { x, y, "text-anchor": anchor, class: className });
    text.textContent = value;
    nodes.chart.append(text);
  };

  const linePath = (points) => points.map(
    (point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)},${point[1].toFixed(2)}`
  ).join(" ");

  const drawAxes = (xMax, yMax) => {
    const width = 920;
    const height = 500;
    const margin = { left: 70, right: 24, top: 28, bottom: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const safeXMax = Math.max(1, xMax);
    const x = (value) => margin.left + (value / safeXMax) * plotWidth;
    const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
    for (let index = 0; index <= 5; index += 1) {
      const xValue = safeXMax * index / 5;
      const yValue = yMax * index / 5;
      nodes.chart.append(
        svgElement("line", { x1: x(xValue), y1: margin.top, x2: x(xValue), y2: margin.top + plotHeight, class: "fp-chart-grid" }),
        svgElement("line", { x1: margin.left, y1: y(yValue), x2: margin.left + plotWidth, y2: y(yValue), class: "fp-chart-grid" })
      );
      chartText(x(xValue), height - 33, `${summaryNumber.format(xValue)} %`);
      chartText(margin.left - 10, y(yValue) + 4, summaryNumber.format(yValue), "end");
    }
    nodes.chart.append(
      svgElement("line", { x1: margin.left, y1: margin.top + plotHeight, x2: margin.left + plotWidth, y2: margin.top + plotHeight, class: "fp-chart-axis" }),
      svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotHeight, class: "fp-chart-axis" })
    );
    chartText(margin.left + plotWidth / 2, height - 5, "Baja sobre el precio de licitación");
    const yLabel = svgElement("text", { x: 18, y: margin.top + plotHeight / 2, transform: `rotate(-90 18 ${margin.top + plotHeight / 2})`, "text-anchor": "middle", class: "fp-chart-label" });
    yLabel.textContent = "Puntos por precio";
    nodes.chart.append(yLabel);
    return { x, y, margin, plotHeight };
  };

  const renderChart = (result) => {
    clearChart();
    const maxDiscount = result.scenario.visual_maximum_discount_pct;
    const axes = drawAxes(maxDiscount, result.scenario.pmax);
    result.curves.forEach((curve) => {
      const color = colorByMethod.get(curve.method_id);
      const points = [...curve.expected_points].sort((a, b) => a.discount_pct - b.discount_pct);
      const path = svgElement("path", {
        d: linePath(points.map((point) => [axes.x(point.discount_pct), axes.y(point.score)])),
        class: "fp-chart-line",
      });
      path.style.setProperty("--series-color", color);
      nodes.chart.append(path);
      if (
        nodes.showResultingCurve.checked
        && curve.method_id === rankingMethodId
        && !curve.curves_coincide
        && curve.resulting_points.length
      ) {
        const resulting = [...curve.resulting_points].sort((a, b) => a.discount_pct - b.discount_pct);
        const resultingPath = svgElement("path", {
          d: linePath(resulting.map((point) => [axes.x(point.discount_pct), axes.y(point.score)])),
          class: "fp-chart-line is-resulting",
        });
        resultingPath.style.setProperty("--series-color", color);
        nodes.chart.append(resultingPath);
      }
    });
    result.rows.forEach((row) => {
      const selected = row.offer_id === selectedOfferId;
      nodes.chart.append(svgElement("line", {
        x1: axes.x(row.discount_pct),
        y1: axes.margin.top,
        x2: axes.x(row.discount_pct),
        y2: axes.margin.top + axes.plotHeight,
        class: `fp-offer-guide${selected ? " is-selected" : ""}`,
      }));
      result.methods.forEach((method) => {
        const theoretical = row.theoretical_scores[method.method_id];
        const difference = row.score_differences[method.method_id];
        const hover = [
          `${row.name} · ${euro.format(row.price)}`,
          `Baja: ${percent.format(row.discount_pct)} %`,
          `Puntuación real: ${summaryNumber.format(row.scores[method.method_id])} puntos`,
          theoretical === null
            ? "Puntuación teórica: fuera del dominio de la Bmax esperada"
            : `Puntuación sobre la curva teórica: ${summaryNumber.format(theoretical)} puntos`,
          difference === null
            ? null
            : `Diferencia: ${difference >= 0 ? "+" : "−"}${summaryNumber.format(Math.abs(difference))} puntos`,
        ].filter(Boolean).join("\n");
        const point = svgElement("circle", {
          cx: axes.x(row.discount_pct),
          cy: axes.y(row.scores[method.method_id]),
          r: selected ? 7 : 5,
          tabindex: "0",
          role: "button",
          "aria-label": hover.replaceAll("\n", ". "),
          class: `fp-chart-point${selected ? " is-selected" : ""}`,
        });
        point.style.setProperty("--series-color", colorByMethod.get(method.method_id));
        const title = svgElement("title");
        title.textContent = hover;
        point.append(title);
        const select = () => {
          selectedOfferId = row.offer_id;
          renderChart(result);
          renderSelectedOffer(result);
        };
        point.addEventListener("click", select);
        point.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") select();
        });
        nodes.chart.append(point);
      });
    });
    nodes.chartLegend.replaceChildren(...result.methods.map((method) => {
      const details = element("details", "fp-legend-equation");
      details.style.setProperty("--series-color", colorByMethod.get(method.method_id));
      const summary = element("summary");
      summary.append(element("i", "fp-series-swatch"), element("span", "", method.name), element("b", "", "i"));
      const body = element("div", "fp-legend-equation-body");
      const equation = element("div", "fp-equation-inline");
      equation.innerHTML = method.equation_mathml;
      const parameterText = Object.entries(method.parameters).map(
        ([key, value]) => `${key} = ${window.FormulaFormat.parameterText(key, value)}`
      ).join(" · ");
      body.append(
        equation,
        element("p", "", `${method.reference_type}${parameterText ? ` · ${parameterText}` : ""}`),
        element("p", "fp-small-copy", method.curve_explanation)
      );
      details.append(summary, body);
      return details;
    }));
    nodes.chartOffers.replaceChildren(...result.rows.map((row) => {
      const button = element("button", row.offer_id === selectedOfferId ? "is-selected" : "");
      button.type = "button";
      button.append(element("strong", "", row.name), element("span", "", `${percent.format(row.discount_pct)} %`));
      button.addEventListener("click", () => {
        selectedOfferId = row.offer_id;
        renderChart(result);
        renderSelectedOffer(result);
      });
      return button;
    }));
  };

  const renderSelectedOffer = (result) => {
    const row = result.rows.find((item) => item.offer_id === selectedOfferId);
    if (!row) {
      nodes.selectedOffer.textContent = "Selecciona un punto LIC-n para fijar sus datos.";
      return;
    }
    const focused = currentMethod(result);
    const theoretical = row.theoretical_scores[focused.method_id];
    const difference = row.score_differences[focused.method_id];
    nodes.selectedOffer.replaceChildren(
      element("strong", "", row.name),
      element("span", "", euro.format(row.price)),
      element("span", "", `Baja ${percent.format(row.discount_pct)} %`),
      element("span", "", `${focused.short_name} real: ${summaryNumber.format(row.scores[focused.method_id])} pt`),
      element("span", "", theoretical === null
        ? "Curva esperada: fuera de dominio"
        : `Curva esperada: ${summaryNumber.format(theoretical)} pt`),
      ...(difference === null ? [] : [element(
        "span",
        "",
        `Diferencia: ${difference >= 0 ? "+" : "−"}${summaryNumber.format(Math.abs(difference))} pt`
      )])
    );
  };

  const renderTables = (result) => {
    const activeIds = new Set(result.rows.map((row) => row.offer_id));
    nodes.caseDataBody.replaceChildren(...offers.map((offer) => {
      const discount = (Number(nodes.tenderPrice.value) - offer.price) / Number(nodes.tenderPrice.value) * 100;
      const row = element("tr", offer.excluded ? "is-excluded" : "");
      row.append(
        element("td", "", offer.name),
        element("td", "", euro.format(offer.price)),
        element("td", "", euro.format(Number(nodes.tenderPrice.value) - offer.price)),
        element("td", "", `${percent.format(discount)} %`),
        element("td", "", summaryNumber.format(offer.non_price_points)),
        element("td", "", activeIds.has(offer.offer_id) ? "Incluida" : "Excluida")
      );
      return row;
    }));
    const precision = scoreDecimals(result);
    const head = element("tr");
    head.append(element("th", "", "Oferta"));
    result.methods.forEach((method) => head.append(element("th", "", method.name)));
    nodes.scoresHead.replaceChildren(head);
    nodes.scoresBody.replaceChildren(...result.rows.map((resultRow) => {
      const row = element("tr");
      row.append(element("td", "", resultRow.name));
      result.methods.forEach((method) => row.append(element(
        "td",
        "",
        formatScore(resultRow.scores[method.method_id], precision.get(method.method_id).decimals)
      )));
      return row;
    }));
    const warnings = [...precision.values()].filter((item) => item.exceedsMaximum).length;
    nodes.precisionNote.textContent = warnings
      ? "Hay empates visuales con 4 decimales; se conserva la ordenación del cálculo completo."
      : "Precisión adaptativa: entre 2 y 4 decimales.";
  };

  const renderConclusions = (result) => {
    const winners = new Set(result.methods.map((method) => rankedRows(result, method.method_id, "total")[0]?.name));
    const method = currentMethod(result);
    const ranking = rankedRows(result, method.method_id, rankingMode);
    const spread = ranking.length ? ranking[0].value - ranking.at(-1).value : 0;
    const impact = result.impacts.find((item) => item.method_id === method.method_id);
    const bmaxDifference = result.scenario.bmax_difference_pp;
    const bmaxConclusion = Math.abs(bmaxDifference) < 0.01
      ? "La Bmax observada coincide con la hipótesis usada para estudiar la curva esperada."
      : `La Bmax real fue del ${percent.format(result.scenario.maximum_discount_pct)} %, frente al ${summaryNumber.format(result.scenario.expected_maximum_discount_pct)} % supuesto. Esta diferencia ${method.depends_on_other_offers ? "modifica el comportamiento efectivo de la fórmula relativa o mixta." : "no altera esta fórmula absoluta."}`;
    const conclusions = profile === "empresa"
      ? [
          bmaxConclusion,
          `${ranking[0]?.name || "La primera oferta"} encabeza la simulación con ${method.name}.`,
          spread < result.scenario.pmax * 0.1
            ? "Las puntuaciones están muy agrupadas; pequeñas diferencias técnicas pueden decidir la clasificación total."
            : `La fórmula separa en ${summaryNumber.format(spread)} puntos a la primera y la última oferta del escenario.`,
          winners.size > 1
            ? "La posición competitiva cambia según la fórmula elegida por el órgano de contratación."
            : "Las fórmulas activas mantienen el mismo ganador total en este escenario.",
          "Una baja sostenible debe contrastarse con costes y capacidad de ejecución, no sólo con la posición matemática.",
        ]
      : [
          bmaxConclusion,
          spread < result.scenario.pmax * 0.1
            ? "La fórmula produce poca separación entre las ofertas económicas de este caso."
            : `La fórmula seleccionada separa en ${summaryNumber.format(spread)} puntos a los extremos de la clasificación.`,
          winners.size > 1
            ? `Las fórmulas activas producen ${winners.size} ganadores totales distintos.`
            : "Las fórmulas activas mantienen el mismo ganador total.",
          impact?.unchanged_price_changed_count
            ? "La simulación altera puntos de ofertas cuyo importe no ha cambiado, porque la fórmula depende del conjunto."
            : "En la simulación actual no cambian puntos de ofertas con el mismo importe.",
          ranking[0]?.name === currentCase.best_technical_offer
            ? "La mejor oferta técnica conserva la primera posición con la configuración observada."
            : "La mejor oferta técnica no queda primera con la configuración observada.",
        ];
    nodes.conclusionList.replaceChildren(...conclusions.map((text) => element("li", "", text)));
  };

  const renderResult = (result) => {
    renderBmaxControl(result);
    renderRankingFormula(result);
    renderPermanentResults(result);
    renderImpact(result);
    renderChart(result);
    renderSelectedOffer(result);
    renderTables(result);
    renderConclusions(result);
  };

  const restoreCase = () => loadCase(currentCase.case_id);

  populateCases();
  renderProfile();
  loadCase(nodes.caseSelector.value || catalog.cases[0].case_id);

  nodes.caseSelector.addEventListener("change", () => loadCase(nodes.caseSelector.value));
  nodes.tenderPrice.addEventListener("input", () => scheduleCompare());
  nodes.pmax.addEventListener("input", () => scheduleCompare());
  const updateExpectedBmax = (raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) return;
    expectedBmaxPct = value;
    nodes.expectedBmax.value = String(Math.min(95, Math.max(5, value)));
    nodes.expectedBmaxNumber.value = String(value);
    renderBmaxControl();
    scheduleCompare();
  };
  nodes.expectedBmax.addEventListener("input", () => updateExpectedBmax(nodes.expectedBmax.value));
  nodes.expectedBmaxNumber.addEventListener("input", () => updateExpectedBmax(nodes.expectedBmaxNumber.value));
  nodes.showResultingCurve.addEventListener("change", () => {
    if (lastResult) renderChart(lastResult);
  });
  $("#restore-case").addEventListener("click", restoreCase);
  $("#restore-case-secondary").addEventListener("click", restoreCase);
  $("#add-offer").addEventListener("click", () => {
    if (offers.length >= catalog.max_offers) {
      setStatus(`El máximo es de ${catalog.max_offers} ofertas.`, "error");
      return;
    }
    offerSequence += 1;
    offers.push({
      offer_id: `offer-user-${offerSequence}`,
      name: `LIC-${offers.length + 1}`,
      price: Number(nodes.tenderPrice.value) * 0.9,
      non_price_points: 0,
      excluded: false,
    });
    renderOffers();
    scheduleCompare(0);
  });
  $("#add-extreme").addEventListener("click", () => {
    if (offers.length >= catalog.max_offers) {
      setStatus(`El máximo es de ${catalog.max_offers} ofertas.`, "error");
      return;
    }
    offerSequence += 1;
    const activeMinimum = Math.min(...offers.filter((offer) => !offer.excluded).map((offer) => offer.price));
    offers.push({
      offer_id: `offer-extreme-${offerSequence}`,
      name: `LIC-${offers.length + 1}`,
      price: Math.max(0.01, activeMinimum * 0.75),
      non_price_points: 0,
      excluded: false,
    });
    renderOffers();
    scheduleCompare(0);
  });
  document.querySelectorAll("#profile-selector [data-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      profile = button.dataset.profile;
      renderProfile();
    });
  });
  document.querySelectorAll("[data-ranking]").forEach((button) => {
    button.addEventListener("click", () => {
      rankingMode = button.dataset.ranking;
      document.querySelectorAll("[data-ranking]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      if (lastResult) {
        renderPermanentResults(lastResult);
        renderConclusions(lastResult);
      }
    });
  });
  nodes.rankingFormula.addEventListener("change", () => {
    rankingMethodId = nodes.rankingFormula.value;
    nodes.understandFormulaLink.href = `${catalog.lab_url}#${rankingMethodId}`;
    if (lastResult) {
      renderPermanentResults(lastResult);
      renderImpact(lastResult);
      renderChart(lastResult);
      renderSelectedOffer(lastResult);
      renderConclusions(lastResult);
    }
  });
})();
