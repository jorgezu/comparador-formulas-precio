(() => {
  "use strict";

  const catalogNode = document.querySelector("#formula-catalog");
  if (!catalogNode || !window.FormulaFormat) return;

  const catalog = JSON.parse(catalogNode.textContent);
  const colors = ["#087f8c", "#c84556", "#3568b8", "#d08a16", "#3d7f58", "#785c99", "#8b5a3c"];
  const contrastColors = ["#111111", "#e69f00", "#0072b2", "#009e73", "#6b4c9a", "#cc79a7", "#d55e00"];
  let colorByMethod = new Map(catalog.methods.map((method, index) => [method.method_id, colors[index]]));
  const euro = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const summaryNumber = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const svgNamespace = "http://www.w3.org/2000/svg";
  const $ = (selector) => document.querySelector(selector);
  const deepCopy = (value) => JSON.parse(JSON.stringify(value));
  const simulationCopy = catalog.editorial.analysis_simulation;
  const chartCopy = catalog.editorial.analysis_chart;
  const reportCopy = catalog.editorial.analysis_report;

  const nodes = {
    caseSelector: $("#case-selector"),
    caseTitle: $("#case-title"),
    caseStripFacts: $("#case-strip-facts"),
    caseNote: $("#case-note"),
    simulationPanel: $("#simulation-panel"),
    simulationKicker: $("#simulation-kicker"),
    simulationTitle: $("#simulation-title"),
    simulationDescription: $("#simulation-description"),
    startSimulation: $("#start-technical-simulation"),
    discardSimulation: $("#discard-technical-simulation"),
    technicalEditor: $("#technical-editor"),
    simulationPmax: $("#simulation-pmax"),
    simulationPmaxReference: $("#simulation-pmax-reference"),
    technicalLimit: $("#technical-limit"),
    technicalFields: $("#technical-fields"),
    chartKicker: $("#chart-kicker"),
    dataTitle: $("#data-title"),
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
    detailZoom: $("#detail-zoom"),
    resetDetailZoom: $("#reset-detail-zoom"),
    colorContrast: $("#color-contrast"),
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
    reportOpen: $("#report-open"),
    reportPreview: $("#report-preview"),
    reportPages: $("#report-pages"),
    reportClose: $("#report-close"),
    reportPrint: $("#report-print"),
  };
  const originalDataTitle = nodes.dataTitle.textContent;
  const originalChartKicker = nodes.chartKicker.textContent;

  let currentCase = null;
  let offers = [];
  let baseline = null;
  let baselineTechnical = null;
  let simulationActive = false;
  let rankingBeforeCopy = "price";
  let methodState = new Map();
  let lastResult = null;
  let rankingMode = "price";
  let rankingMethodId = null;
  let selectedOfferId = null;
  let expectedBmaxPct = 30;
  let detailZoomBounds = null;
  let detailZoomCustom = false;
  let debounceTimer = null;
  let requestController = null;
  let offerSequence = 20;
  let reportScrollY = 0;
  let profile = new URLSearchParams(window.location.search).get("perfil") === "empresa"
    ? "empresa"
    : "administracion";

  const element = (name, className = "", text) => {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const editableNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : "";
  };

  const syncOfferPriceInputs = (offerId, value, source) => {
    document.querySelectorAll("input[data-offer-price]").forEach((input) => {
      if (input !== source && input.dataset.offerPrice === offerId) {
        input.value = editableNumber(value);
      }
    });
  };

  const svgElement = (name, attributes = {}) => {
    const node = document.createElementNS(svgNamespace, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };

  const applyColorContrast = () => {
    const palette = nodes.colorContrast.checked ? contrastColors : colors;
    colorByMethod = new Map(
      catalog.methods.map((method, index) => [method.method_id, palette[index]])
    );
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
    && JSON.stringify(baseline) === JSON.stringify(currentScenario())
    && JSON.stringify(baselineTechnical) === JSON.stringify(
      offers.map(({ offer_id, non_price_points }) => ({ offer_id, non_price_points }))
    );

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

  const syncRankingButtons = () => {
    document.querySelectorAll("[data-ranking]").forEach((button) => {
      const active = button.dataset.ranking === rankingMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  const renderProfile = () => {
    document.querySelectorAll("#profile-selector [data-profile]").forEach((button) => {
      const active = button.dataset.profile === profile;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const profileCopy = catalog.editorial.analysis_profiles[profile];
    nodes.scenarioGuidance.textContent = profileCopy.guidance;
    if (nodes.commercialTitle && nodes.commercialCopy) {
      nodes.commercialTitle.textContent = profileCopy.commercial_title;
      nodes.commercialCopy.textContent = profileCopy.commercial_body;
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

  const publicCaseHeading = (selectedCase) => selectedCase.complexity_level
    ? `${selectedCase.label} · Complejidad ${selectedCase.complexity_level.toLocaleLowerCase("es-ES")}`
    : selectedCase.label;

  const renderCaseStrip = () => {
    const actualMethod = catalog.methods.find(
      (method) => method.method_id === currentCase.actual_method_id
    );
    nodes.caseTitle.textContent = simulationActive
      ? simulationCopy.simulation_case_prefix + publicCaseHeading(currentCase)
      : publicCaseHeading(currentCase);
    nodes.caseNote.textContent = simulationActive ? simulationCopy.simulation_note : currentCase.note;
    nodes.caseStripFacts.replaceChildren(
      stripFact("Tipo", currentCase.contract_type),
      stripFact("Precio de licitación", euro.format(currentCase.tender_price)),
      stripFact("Puntos precio", summaryNumber.format(currentCase.pmax)),
      stripFact("Ofertas", String(currentCase.offers.length)),
      stripFact("Fórmula real", actualMethod?.name || currentCase.actual_method_name),
      stripFact("Adjudicatario real", currentCase.actual_awardee, true)
    );
  };

  const renderTechnicalFields = () => {
    nodes.technicalFields.replaceChildren(...offers.map((offer) => {
      const field = element("section", `fp-technical-field${offer.excluded ? " is-excluded" : ""}`);
      const heading = element("div", "fp-technical-field-heading");
      heading.append(element("strong", "", offer.name));
      const controls = element("div", "fp-technical-field-controls");
      const original = currentCase.offers.find((item) => item.offer_id === offer.offer_id);

      const priceLabel = element("label", "fp-technical-control");
      const priceInput = element("input");
      priceInput.type = "number";
      priceInput.inputMode = "decimal";
      priceInput.min = "0.01";
      priceInput.max = String(Number(nodes.tenderPrice.value));
      priceInput.step = "0.01";
      priceInput.value = editableNumber(offer.price);
      priceInput.disabled = offer.excluded;
      priceInput.dataset.offerPrice = offer.offer_id;
      priceInput.setAttribute("aria-label", `${simulationCopy.simulation_offer_price} de ${offer.name}`);
      priceInput.addEventListener("input", () => {
        priceInput.max = String(Number(nodes.tenderPrice.value));
        const value = Number(priceInput.value);
        const valid = priceInput.value !== ""
          && priceInput.validity.valid
          && Number.isFinite(value)
          && value > 0
          && value <= Number(nodes.tenderPrice.value);
        priceInput.setAttribute("aria-invalid", String(!valid));
        if (!valid) {
          setStatus(simulationCopy.simulation_offer_price_error, "error");
          return;
        }
        offer.price = value;
        syncOfferPriceInputs(offer.offer_id, value, priceInput);
        scheduleCompare();
        setStatus(simulationCopy.simulation_offer_price_updated);
      });
      const normalizePriceInput = () => {
        if (priceInput.getAttribute("aria-invalid") === "true") {
          priceInput.value = editableNumber(offer.price);
          priceInput.removeAttribute("aria-invalid");
        } else {
          priceInput.value = editableNumber(offer.price);
        }
      };
      priceInput.addEventListener("change", normalizePriceInput);
      priceInput.addEventListener("blur", normalizePriceInput);
      priceLabel.append(
        element("span", "", simulationCopy.simulation_offer_price),
        priceInput,
        element("small", "", original
          ? `${simulationCopy.simulation_original}: ${euro.format(original.price)}`
          : "")
      );

      const technicalLabel = element("label", "fp-technical-control");
      const technicalInput = element("input");
      technicalInput.type = "number";
      technicalInput.inputMode = "decimal";
      technicalInput.min = "0";
      technicalInput.max = String(currentCase.non_price_max);
      technicalInput.step = "0.01";
      technicalInput.value = editableNumber(offer.non_price_points);
      technicalInput.disabled = offer.excluded;
      technicalInput.setAttribute("aria-label", `${simulationCopy.simulation_non_price_points} de ${offer.name}`);
      technicalInput.addEventListener("input", () => {
        const value = Number(technicalInput.value);
        const valid = technicalInput.value !== ""
          && technicalInput.validity.valid
          && Number.isFinite(value);
        technicalInput.setAttribute("aria-invalid", String(!valid));
        if (!valid) {
          setStatus(simulationCopy.simulation_limit_error.replace(
            "{maximum}", summaryNumber.format(currentCase.non_price_max)
          ), "error");
          return;
        }
        offer.non_price_points = value;
        if (lastResult) {
          renderPermanentResults(lastResult);
          renderImpact(lastResult);
          renderTables(lastResult);
          renderConclusions(lastResult);
        }
        setStatus(simulationCopy.simulation_updated);
      });
      const normalizeTechnicalInput = () => {
        if (technicalInput.getAttribute("aria-invalid") === "true") {
          technicalInput.value = editableNumber(offer.non_price_points);
          technicalInput.removeAttribute("aria-invalid");
        } else {
          technicalInput.value = editableNumber(offer.non_price_points);
        }
      };
      technicalInput.addEventListener("change", normalizeTechnicalInput);
      technicalInput.addEventListener("blur", normalizeTechnicalInput);
      technicalLabel.append(
        element("span", "", simulationCopy.simulation_non_price_points),
        technicalInput,
        element("small", "", original
          ? `${simulationCopy.simulation_original}: ${summaryNumber.format(original.non_price_points)}`
          : "")
      );
      controls.append(priceLabel, technicalLabel);
      field.append(heading, controls);
      return field;
    }));
  };

  const renderSimulationPanel = () => {
    nodes.simulationPanel.classList.toggle("is-active", simulationActive);
    nodes.simulationKicker.textContent = simulationActive
      ? simulationCopy.simulation_active_kicker
      : simulationCopy.simulation_kicker;
    nodes.simulationTitle.textContent = simulationActive
      ? `${simulationCopy.simulation_active_title} · ${currentCase.label}`
      : simulationCopy.simulation_title;
    nodes.simulationDescription.textContent = simulationActive
      ? simulationCopy.simulation_active_description
      : simulationCopy.simulation_description;
    nodes.startSimulation.hidden = simulationActive;
    nodes.discardSimulation.hidden = !simulationActive;
    nodes.technicalEditor.hidden = !simulationActive;
    nodes.dataTitle.textContent = simulationActive ? simulationCopy.simulation_data_title : originalDataTitle;
    nodes.chartKicker.textContent = simulationActive ? simulationCopy.simulation_chart_kicker : originalChartKicker;
    if (simulationActive) {
      nodes.simulationPmax.value = editableNumber(nodes.pmax.value);
      nodes.simulationPmaxReference.textContent = simulationCopy.simulation_price_points_real.replace(
        "{value}", summaryNumber.format(currentCase.pmax)
      );
      nodes.technicalLimit.textContent = `${simulationCopy.simulation_maximum} ${summaryNumber.format(currentCase.non_price_max)}`;
      renderTechnicalFields();
    }
  };

  const loadCase = (caseId) => {
    window.clearTimeout(debounceTimer);
    if (requestController) requestController.abort();
    lastResult = null;
    nodes.reportOpen.disabled = true;
    detailZoomBounds = null;
    detailZoomCustom = false;
    nodes.resetDetailZoom.hidden = true;
    if (simulationActive) rankingMode = rankingBeforeCopy;
    simulationActive = false;
    syncRankingButtons();
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
    baselineTechnical = offers.map(({ offer_id, non_price_points }) => ({ offer_id, non_price_points }));
    methodState = defaultStateForCase(currentCase);
    rankingMethodId = currentCase.actual_formula_supported ? currentCase.actual_method_id : null;
    selectedOfferId = null;
    renderCaseStrip();
    renderSimulationPanel();
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
      input.dataset.offerPrice = offer.offer_id;
      input.setAttribute("aria-label", `Importe de ${offer.name}`);
      input.addEventListener("input", () => {
        offer.price = Number(input.value);
        syncOfferPriceInputs(offer.offer_id, offer.price, input);
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
    if (simulationActive) renderTechnicalFields();
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
      nodes.impactSummary.textContent = simulationActive
        ? simulationCopy.simulation_unchanged
        : "Estás viendo la configuración real del caso.";
      return;
    }
    if (JSON.stringify(baseline) === JSON.stringify(currentScenario())) {
      nodes.impactSummary.textContent = simulationCopy.simulation_technical_impact;
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
    return { x, y, margin, plotWidth, plotHeight, xMax: safeXMax, yMax };
  };

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  const interpolateCurveScore = (points, discountPct) => {
    const sorted = [...points].sort((left, right) => left.discount_pct - right.discount_pct);
    if (
      !sorted.length
      || discountPct < sorted[0].discount_pct - 1e-8
      || discountPct > sorted[sorted.length - 1].discount_pct + 1e-8
    ) return null;
    const exact = sorted.find((point) => Math.abs(point.discount_pct - discountPct) < 1e-8);
    if (exact) return exact.score;
    for (let index = 1; index < sorted.length; index += 1) {
      const left = sorted[index - 1];
      const right = sorted[index];
      if (discountPct > right.discount_pct) continue;
      const ratio = (discountPct - left.discount_pct) / (right.discount_pct - left.discount_pct);
      return left.score + (right.score - left.score) * ratio;
    }
    return null;
  };

  const curvePointsInBounds = (points, bounds) => {
    const bounded = [...points]
      .filter((point) => point.discount_pct > bounds.xMin && point.discount_pct < bounds.xMax)
      .sort((left, right) => left.discount_pct - right.discount_pct);
    const startScore = interpolateCurveScore(points, bounds.xMin);
    const endScore = interpolateCurveScore(points, bounds.xMax);
    if (startScore !== null) bounded.unshift({ discount_pct: bounds.xMin, score: startScore });
    if (endScore !== null) bounded.push({ discount_pct: bounds.xMax, score: endScore });
    return bounded;
  };

  const detailCurveSeries = (result) => result.curves.flatMap((curve) => {
    const series = [{
      methodId: curve.method_id,
      points: curve.expected_points,
      resulting: false,
    }];
    if (
      nodes.showResultingCurve.checked
      && curve.method_id === rankingMethodId
      && !curve.curves_coincide
      && curve.resulting_points.length
    ) {
      series.push({
        methodId: curve.method_id,
        points: curve.resulting_points,
        resulting: true,
      });
    }
    return series;
  });

  const normalizeDetailBounds = (bounds, xMaximum, yMaximum) => {
    const normalized = {
      xMin: clamp(Math.min(bounds.xMin, bounds.xMax), 0, xMaximum),
      xMax: clamp(Math.max(bounds.xMin, bounds.xMax), 0, xMaximum),
      yMin: clamp(Math.min(bounds.yMin, bounds.yMax), 0, yMaximum),
      yMax: clamp(Math.max(bounds.yMin, bounds.yMax), 0, yMaximum),
    };
    const minimumXSpan = Math.min(xMaximum, Math.max(0.5, xMaximum * 0.04));
    const minimumYSpan = Math.min(yMaximum, Math.max(1, yMaximum * 0.04));
    if (normalized.xMax - normalized.xMin < minimumXSpan) {
      const center = (normalized.xMin + normalized.xMax) / 2;
      normalized.xMin = clamp(center - minimumXSpan / 2, 0, xMaximum - minimumXSpan);
      normalized.xMax = normalized.xMin + minimumXSpan;
    }
    if (normalized.yMax - normalized.yMin < minimumYSpan) {
      const center = (normalized.yMin + normalized.yMax) / 2;
      normalized.yMin = clamp(center - minimumYSpan / 2, 0, yMaximum - minimumYSpan);
      normalized.yMax = normalized.yMin + minimumYSpan;
    }
    return normalized;
  };

  const automaticDetailBounds = (result) => {
    const xMaximum = result.scenario.visual_maximum_discount_pct;
    const yMaximum = result.scenario.pmax;
    const discounts = result.rows.map((row) => row.discount_pct).sort((left, right) => left - right);
    let cluster = discounts;
    if (discounts.length >= 4) {
      const windowSize = Math.max(3, Math.ceil(discounts.length * 0.65));
      cluster = discounts.slice(0, windowSize);
      for (let start = 1; start <= discounts.length - windowSize; start += 1) {
        const candidate = discounts.slice(start, start + windowSize);
        if (candidate[candidate.length - 1] - candidate[0] < cluster[cluster.length - 1] - cluster[0]) {
          cluster = candidate;
        }
      }
    }
    const clusterMin = cluster[0] ?? 0;
    const clusterMax = cluster[cluster.length - 1] ?? xMaximum;
    const clusterSpan = Math.max(clusterMax - clusterMin, xMaximum * 0.08);
    const xPadding = Math.max(1, clusterSpan * 0.55);
    let xMin = clamp(clusterMin - xPadding, 0, xMaximum);
    let xMax = clamp(clusterMax + xPadding, 0, xMaximum);
    const preferredXSpan = Math.min(xMaximum, Math.max(4, xMaximum * 0.22));
    if (xMax - xMin < preferredXSpan) {
      const center = (xMin + xMax) / 2;
      xMin = clamp(center - preferredXSpan / 2, 0, xMaximum - preferredXSpan);
      xMax = xMin + preferredXSpan;
    }
    const provisional = { xMin, xMax, yMin: 0, yMax: yMaximum };
    const boundedSeries = detailCurveSeries(result).map((series) => {
      const seriesScores = curvePointsInBounds(series.points, provisional)
        .map((point) => point.score)
        .sort((left, right) => left - right);
      return {
        ...series,
        scores: seriesScores,
        center: seriesScores[Math.floor(seriesScores.length / 2)] ?? 0,
      };
    }).filter((series) => series.scores.length);
    let focusedSeries = boundedSeries;
    if (boundedSeries.length >= 3) {
      const sortedSeries = [...boundedSeries].sort((left, right) => left.center - right.center);
      const windowSize = Math.max(2, Math.ceil(sortedSeries.length * 0.65));
      focusedSeries = sortedSeries.slice(0, windowSize);
      for (let start = 1; start <= sortedSeries.length - windowSize; start += 1) {
        const candidate = sortedSeries.slice(start, start + windowSize);
        if (
          candidate[candidate.length - 1].center - candidate[0].center
          < focusedSeries[focusedSeries.length - 1].center - focusedSeries[0].center
        ) focusedSeries = candidate;
      }
    }
    const focusedMethodIds = new Set(focusedSeries.map((series) => series.methodId));
    const scores = focusedSeries.flatMap((series) => series.scores);
    result.rows
      .filter((row) => row.discount_pct >= xMin && row.discount_pct <= xMax)
      .forEach((row) => result.methods
        .filter((method) => focusedMethodIds.has(method.method_id))
        .forEach((method) => scores.push(row.scores[method.method_id])));
    if (!scores.length) return provisional;
    const scoreMin = Math.min(...scores);
    const scoreMax = Math.max(...scores);
    const scoreSpan = Math.max(scoreMax - scoreMin, yMaximum * 0.12);
    const yPadding = Math.max(1.5, scoreSpan * 0.18);
    let yMin = clamp(scoreMin - yPadding, 0, yMaximum);
    let yMax = clamp(scoreMax + yPadding, 0, yMaximum);
    const preferredYSpan = Math.min(yMaximum, Math.max(8, yMaximum * 0.24));
    if (yMax - yMin < preferredYSpan) {
      const center = (yMin + yMax) / 2;
      yMin = clamp(center - preferredYSpan / 2, 0, yMaximum - preferredYSpan);
      yMax = yMin + preferredYSpan;
    }
    return normalizeDetailBounds({ xMin, xMax, yMin, yMax }, xMaximum, yMaximum);
  };

  const chartPointer = (event) => {
    const matrix = nodes.chart.getScreenCTM();
    if (!matrix) return null;
    const point = nodes.chart.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  };

  const installDetailZoomSelection = (result, axes) => {
    const surface = svgElement("rect", {
      x: axes.margin.left,
      y: axes.margin.top,
      width: axes.plotWidth,
      height: axes.plotHeight,
      class: "fp-detail-select-surface",
      "aria-label": chartCopy.detail_zoom_help,
    });
    let start = null;
    let selection = null;
    const updateSelection = (event) => {
      if (!start || !selection) return;
      const point = chartPointer(event);
      if (!point) return;
      const currentX = clamp(point.x, axes.margin.left, axes.margin.left + axes.plotWidth);
      const currentY = clamp(point.y, axes.margin.top, axes.margin.top + axes.plotHeight);
      selection.setAttribute("x", String(Math.min(start.x, currentX)));
      selection.setAttribute("y", String(Math.min(start.y, currentY)));
      selection.setAttribute("width", String(Math.abs(currentX - start.x)));
      selection.setAttribute("height", String(Math.abs(currentY - start.y)));
    };
    const finishSelection = (event) => {
      if (!start || !selection) return;
      updateSelection(event);
      const x = Number(selection.getAttribute("x"));
      const y = Number(selection.getAttribute("y"));
      const width = Number(selection.getAttribute("width"));
      const height = Number(selection.getAttribute("height"));
      start = null;
      selection.remove();
      selection = null;
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      if (width < 14 || height < 14) return;
      const plotBottom = axes.margin.top + axes.plotHeight;
      detailZoomBounds = normalizeDetailBounds({
        xMin: (x - axes.margin.left) / axes.plotWidth * axes.xMax,
        xMax: (x + width - axes.margin.left) / axes.plotWidth * axes.xMax,
        yMin: (plotBottom - (y + height)) / axes.plotHeight * axes.yMax,
        yMax: (plotBottom - y) / axes.plotHeight * axes.yMax,
      }, axes.xMax, axes.yMax);
      detailZoomCustom = true;
      renderChart(result);
    };
    surface.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const point = chartPointer(event);
      if (!point) return;
      start = {
        x: clamp(point.x, axes.margin.left, axes.margin.left + axes.plotWidth),
        y: clamp(point.y, axes.margin.top, axes.margin.top + axes.plotHeight),
      };
      selection = svgElement("rect", {
        x: start.x,
        y: start.y,
        width: 0,
        height: 0,
        class: "fp-detail-drag-selection",
      });
      nodes.chart.append(selection);
      surface.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    surface.addEventListener("pointermove", updateSelection);
    surface.addEventListener("pointerup", finishSelection);
    surface.addEventListener("pointercancel", finishSelection);
    nodes.chart.append(surface);
  };

  const renderDetailZoom = (result, axes, bounds) => {
    const source = {
      x: axes.x(bounds.xMin),
      y: axes.y(bounds.yMax),
      width: axes.x(bounds.xMax) - axes.x(bounds.xMin),
      height: axes.y(bounds.yMin) - axes.y(bounds.yMax),
    };
    const frame = { x: 558, y: 266, width: 336, height: 168 };
    const plot = {
      left: frame.x + 42,
      right: frame.x + frame.width - 11,
      top: frame.y + 27,
      bottom: frame.y + frame.height - 27,
    };
    const group = svgElement("g", {
      class: "fp-detail-zoom",
      "aria-hidden": "true",
      "pointer-events": "none",
    });
    const sourceCenter = source.x + source.width / 2;
    const connectFromRight = sourceCenter <= frame.x + frame.width / 2;
    const sourceEdge = connectFromRight ? source.x + source.width : source.x;
    const frameEdge = connectFromRight ? frame.x : frame.x + frame.width;
    group.append(
      svgElement("line", {
        x1: sourceEdge,
        y1: source.y,
        x2: frameEdge,
        y2: frame.y,
        class: "fp-detail-connector",
      }),
      svgElement("line", {
        x1: sourceEdge,
        y1: source.y + source.height,
        x2: frameEdge,
        y2: frame.y + frame.height,
        class: "fp-detail-connector",
      }),
      svgElement("rect", {
        x: source.x,
        y: source.y,
        width: source.width,
        height: source.height,
        class: "fp-detail-source",
      }),
      svgElement("rect", {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        rx: 6,
        class: "fp-detail-frame",
      })
    );
    const clipId = "formula-detail-zoom-clip";
    const definitions = svgElement("defs");
    const clipPath = svgElement("clipPath", { id: clipId });
    clipPath.append(svgElement("rect", {
      x: plot.left,
      y: plot.top,
      width: plot.right - plot.left,
      height: plot.bottom - plot.top,
    }));
    definitions.append(clipPath);
    group.append(definitions);
    const detailX = (value) => plot.left
      + (value - bounds.xMin) / (bounds.xMax - bounds.xMin) * (plot.right - plot.left);
    const detailY = (value) => plot.bottom
      - (value - bounds.yMin) / (bounds.yMax - bounds.yMin) * (plot.bottom - plot.top);
    for (let index = 0; index <= 2; index += 1) {
      const xValue = bounds.xMin + (bounds.xMax - bounds.xMin) * index / 2;
      const yValue = bounds.yMin + (bounds.yMax - bounds.yMin) * index / 2;
      group.append(
        svgElement("line", { x1: detailX(xValue), y1: plot.top, x2: detailX(xValue), y2: plot.bottom, class: "fp-detail-grid" }),
        svgElement("line", { x1: plot.left, y1: detailY(yValue), x2: plot.right, y2: detailY(yValue), class: "fp-detail-grid" })
      );
      const xLabel = svgElement("text", { x: detailX(xValue), y: frame.y + frame.height - 8, "text-anchor": "middle", class: "fp-detail-axis-label" });
      xLabel.textContent = `${summaryNumber.format(xValue)} %`;
      const yLabel = svgElement("text", { x: plot.left - 7, y: detailY(yValue) + 3, "text-anchor": "end", class: "fp-detail-axis-label" });
      yLabel.textContent = summaryNumber.format(yValue);
      group.append(xLabel, yLabel);
    }
    const title = svgElement("text", { x: frame.x + 11, y: frame.y + 18, class: "fp-detail-title" });
    title.textContent = chartCopy.detail_zoom_label;
    group.append(title);
    const clipped = svgElement("g", { "clip-path": `url(#${clipId})` });
    detailCurveSeries(result).forEach((series) => {
      const points = curvePointsInBounds(series.points, bounds);
      if (points.length < 2) return;
      const path = svgElement("path", {
        d: linePath(points.map((point) => [detailX(point.discount_pct), detailY(point.score)])),
        class: `fp-detail-line${series.resulting ? " is-resulting" : ""}`,
      });
      path.style.setProperty("--series-color", colorByMethod.get(series.methodId));
      clipped.append(path);
    });
    result.rows
      .filter((row) => row.discount_pct >= bounds.xMin && row.discount_pct <= bounds.xMax)
      .forEach((row) => result.methods.forEach((method) => {
        const score = row.scores[method.method_id];
        if (score < bounds.yMin || score > bounds.yMax) return;
        const point = svgElement("circle", {
          cx: detailX(row.discount_pct),
          cy: detailY(score),
          r: 3.2,
          class: "fp-detail-point",
        });
        point.style.setProperty("--series-color", colorByMethod.get(method.method_id));
        clipped.append(point);
      }));
    group.append(clipped);
    nodes.chart.append(group);
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
    if (nodes.detailZoom.checked) {
      detailZoomBounds = detailZoomCustom && detailZoomBounds
        ? normalizeDetailBounds(detailZoomBounds, axes.xMax, axes.yMax)
        : automaticDetailBounds(result);
      installDetailZoomSelection(result, axes);
    }
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
    if (nodes.detailZoom.checked && detailZoomBounds) {
      renderDetailZoom(result, axes, detailZoomBounds);
    }
    nodes.resetDetailZoom.hidden = !nodes.detailZoom.checked || !detailZoomCustom;
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
          ranking[0]?.name === (simulationActive
            ? [...offers].filter((offer) => !offer.excluded).sort((a, b) => b.non_price_points - a.non_price_points || a.price - b.price)[0]?.name
            : currentCase.best_technical_offer)
            ? `La mejor oferta técnica conserva la primera posición con ${simulationActive ? "esta simulación" : "la configuración observada"}.`
            : `La mejor oferta técnica no queda primera con ${simulationActive ? "esta simulación" : "la configuración observada"}.`,
        ];
    nodes.conclusionList.replaceChildren(...conclusions.map((text) => element("li", "", text)));
  };

  const reportWatermarkPreference = "tenderlab-report-without-watermark";

  const reportWatermarkDisabled = () => {
    try {
      return window.localStorage.getItem(reportWatermarkPreference) === "1";
    } catch (_error) {
      return false;
    }
  };

  const cleanReportClone = (source, className = "") => {
    const clone = source.cloneNode(true);
    if (className) clone.setAttribute("class", className);
    [clone, ...clone.querySelectorAll("*")].forEach((item) => {
      item.removeAttribute("id");
      item.removeAttribute("for");
      item.removeAttribute("aria-labelledby");
      item.removeAttribute("aria-describedby");
      item.removeAttribute("tabindex");
    });
    clone.querySelectorAll(".fp-detail-select-surface, .fp-detail-drag-selection").forEach((item) => item.remove());
    return clone;
  };

  const reportPage = () => {
    const page = element("section", "fp-report-page");
    page.dataset.watermark = reportCopy.report_watermark;
    return page;
  };

  const reportHeader = (caseLabel, contextLabel, generatedAt, pageNumber, pageCount) => {
    const header = element("header", "fp-report-header");
    const identity = element("div", "fp-report-identity");
    identity.append(
      element("p", "fp-kicker", reportCopy.report_kicker),
      element("h1", "", reportCopy.report_title),
      element("h2", "", caseLabel)
    );
    const meta = element("dl", "fp-report-meta");
    const addMeta = (label, value) => {
      const item = element("div");
      item.append(element("dt", "", label), element("dd", "", value));
      meta.append(item);
    };
    addMeta(reportCopy.report_profile, profile === "empresa" ? "Empresa" : "Administración");
    addMeta(reportCopy.report_context, contextLabel);
    addMeta(reportCopy.report_generated, generatedAt);
    addMeta("Página", `${pageNumber}/${pageCount}`);
    header.append(identity, meta);
    return header;
  };

  const reportFooter = (pageNumber, pageCount) => {
    const footer = element("footer", "fp-report-page-footer");
    footer.append(
      element("span", "", reportCopy.report_footer),
      element("strong", "", `${reportCopy.report_watermark} · ${pageNumber}/${pageCount}`)
    );
    return footer;
  };

  const reportHeading = (title, text = "") => {
    const heading = element("div", "fp-report-section-heading");
    heading.append(element("h2", "", title));
    if (text) heading.append(element("p", "", text));
    return heading;
  };

  const reportMetric = (label, value, accent = false) => {
    const item = element("div", `fp-report-metric${accent ? " is-accent" : ""}`);
    item.append(element("span", "", label), element("strong", "", value || "—"));
    return item;
  };

  const reportFact = (label, value, accent = false) => {
    const item = element("div", accent ? "is-accent" : "");
    item.append(element("span", "", label), element("strong", "", value));
    return item;
  };

  const reportFacts = (method) => {
    const facts = element("div", "fp-report-facts");
    facts.append(
      reportFact(reportCopy.report_type, currentCase.contract_type),
      reportFact(reportCopy.report_tender_price, euro.format(Number(nodes.tenderPrice.value))),
      reportFact(reportCopy.report_price_points, summaryNumber.format(Number(nodes.pmax.value))),
      reportFact(reportCopy.report_included_offers, String(offers.filter((offer) => !offer.excluded).length)),
      reportFact(reportCopy.report_formula, method.name),
      reportFact(reportCopy.report_actual_awardee, currentCase.actual_awardee, true)
    );
    return facts;
  };

  const reportLegend = (result) => {
    const legend = element("div", "fp-report-legend");
    result.methods.forEach((method) => {
      const item = element("span");
      const swatch = element("i");
      swatch.style.backgroundColor = colorByMethod.get(method.method_id);
      item.append(swatch, document.createTextNode(method.name));
      legend.append(item);
    });
    return legend;
  };

  const reportRankingTable = (result, method) => {
    const ranking = rankedRows(result, method.method_id, rankingMode);
    const precision = window.FormulaFormat.adaptiveDecimals(
      ranking.map((row) => row.value), 2, 4
    ).decimals;
    const table = element("table", "fp-report-table fp-report-ranking-table");
    const header = element("tr");
    [
      reportCopy.report_position,
      reportCopy.report_offer,
      reportCopy.report_economic_points,
      reportCopy.report_non_price_points,
      reportCopy.report_result,
    ].forEach((label) => header.append(element("th", "", label)));
    const head = element("thead");
    head.append(header);
    const body = element("tbody");
    ranking.forEach((row, index) => {
      const economic = Number(row.scores[method.method_id]);
      const technical = nonPricePoints(row.offer_id);
      const item = element("tr", index === 0 ? "is-report-winner" : "");
      item.append(
        element("td", "", String(index + 1)),
        element("td", "", row.name),
        element("td", "", formatScore(economic, precision)),
        element("td", "", formatScore(technical, 2)),
        element("td", "", formatScore(row.value, precision))
      );
      body.append(item);
    });
    table.append(head, body);
    return table;
  };

  const buildReportPreview = () => {
    if (!lastResult || !currentCase) return;
    const method = currentMethod(lastResult);
    const ranking = rankedRows(lastResult, method.method_id, rankingMode);
    const generatedAt = new Intl.DateTimeFormat("es-ES", {
      dateStyle: "long",
      timeStyle: "short",
    }).format(new Date());
    const contextLabel = simulationActive ? reportCopy.report_simulation : reportCopy.report_real_case;
    const separateScoresPage = offers.filter((offer) => !offer.excluded).length > 10
      || lastResult.methods.length > 5;
    const pageCount = separateScoresPage ? 3 : 2;

    const firstPage = reportPage();
    firstPage.append(reportHeader(nodes.caseTitle.textContent, contextLabel, generatedAt, 1, pageCount));
    firstPage.append(reportFacts(method));

    const overview = element("div", "fp-report-overview");
    const chartSection = element("section", "fp-report-chart-section");
    chartSection.append(reportHeading(reportCopy.report_chart_title));
    const chartFrame = element("div", "fp-report-chart-frame");
    chartFrame.append(cleanReportClone(nodes.chart, "fp-report-chart-svg"));
    chartSection.append(chartFrame, reportLegend(lastResult));

    const resultSection = element("section", "fp-report-result-section");
    resultSection.append(reportHeading(reportCopy.report_result_title));
    const metrics = element("div", "fp-report-metrics");
    metrics.append(
      reportMetric(reportCopy.report_formula, method.name),
      reportMetric(
        reportCopy.report_classification,
        rankingMode === "total" ? reportCopy.report_total : reportCopy.report_price_only
      ),
      reportMetric(reportCopy.report_simulated_winner, ranking[0]?.name, true),
      reportMetric(reportCopy.report_actual_awardee, currentCase.actual_awardee)
    );
    resultSection.append(
      metrics,
      cleanReportClone(nodes.bmaxSummary, "fp-report-bmax"),
      cleanReportClone(nodes.baselineCompare, "fp-report-baseline")
    );
    overview.append(chartSection, resultSection);
    firstPage.append(overview);

    const interpretation = element("section", "fp-report-interpretation");
    interpretation.append(reportHeading(reportCopy.report_interpretation_title));
    const interpretationList = element("ul");
    [...nodes.conclusionList.children].forEach((item) => {
      interpretationList.append(element("li", "", item.textContent));
    });
    interpretation.append(interpretationList);
    firstPage.append(interpretation, reportFooter(1, pageCount));

    const secondPage = reportPage();
    secondPage.append(reportHeader(nodes.caseTitle.textContent, contextLabel, generatedAt, 2, pageCount));
    secondPage.append(reportHeading(reportCopy.report_data_title, reportCopy.report_scope));
    const dataGrid = element("div", "fp-report-data-grid");
    const offersSection = element("section", "fp-report-table-section");
    offersSection.append(
      reportHeading(reportCopy.report_offers_title),
      cleanReportClone(nodes.caseDataBody.closest("table"), "fp-report-table")
    );
    const rankingSection = element("section", "fp-report-table-section");
    rankingSection.append(
      reportHeading(reportCopy.report_ranking_title, `${method.name} · ${rankingMode === "total" ? reportCopy.report_total : reportCopy.report_price_only}`),
      reportRankingTable(lastResult, method)
    );
    dataGrid.append(offersSection, rankingSection);
    secondPage.append(dataGrid);
    const scoresSection = element("section", "fp-report-table-section fp-report-scores-section");
    scoresSection.append(
      reportHeading(reportCopy.report_scores_title, nodes.precisionNote.textContent),
      cleanReportClone(nodes.scoresBody.closest("table"), "fp-report-table")
    );
    if (separateScoresPage) {
      const thirdPage = reportPage();
      thirdPage.append(
        reportHeader(nodes.caseTitle.textContent, contextLabel, generatedAt, 3, pageCount),
        scoresSection,
        reportFooter(3, pageCount)
      );
      secondPage.append(reportFooter(2, pageCount));
      nodes.reportPages.replaceChildren(firstPage, secondPage, thirdPage);
    } else {
      secondPage.append(scoresSection, reportFooter(2, pageCount));
      nodes.reportPages.replaceChildren(firstPage, secondPage);
    }
  };

  const openReportPreview = () => {
    if (!lastResult) return;
    buildReportPreview();
    reportScrollY = window.scrollY;
    document.body.classList.toggle("fp-report-owner", reportWatermarkDisabled());
    document.body.classList.add("is-report-open");
    nodes.reportPreview.hidden = false;
    window.scrollTo(0, 0);
    nodes.reportClose.focus();
  };

  const closeReportPreview = () => {
    document.body.classList.remove("is-report-open");
    nodes.reportPreview.hidden = true;
    window.scrollTo(0, reportScrollY);
    nodes.reportOpen.focus();
  };

  const printReport = () => {
    const originalTitle = document.title;
    document.title = `TenderLab · ${currentCase.label}`;
    window.print();
    window.setTimeout(() => { document.title = originalTitle; }, 1000);
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
    nodes.reportOpen.disabled = false;
  };

  const restoreCase = () => loadCase(currentCase.case_id);

  populateCases();
  renderProfile();
  loadCase(nodes.caseSelector.value || catalog.cases[0].case_id);

  nodes.caseSelector.addEventListener("change", () => loadCase(nodes.caseSelector.value));
  nodes.tenderPrice.addEventListener("input", () => scheduleCompare());
  nodes.pmax.addEventListener("input", () => {
    nodes.simulationPmax.value = nodes.pmax.value;
    scheduleCompare();
  });
  nodes.simulationPmax.addEventListener("input", () => {
    const value = Number(nodes.simulationPmax.value);
    const valid = nodes.simulationPmax.value !== "" && Number.isFinite(value) && value > 0;
    nodes.simulationPmax.setAttribute("aria-invalid", String(!valid));
    if (!valid) {
      setStatus(simulationCopy.simulation_price_points_error, "error");
      return;
    }
    nodes.pmax.value = String(value);
    setStatus(simulationCopy.simulation_price_points_updated);
    scheduleCompare();
  });
  nodes.simulationPmax.addEventListener("change", () => {
    if (nodes.simulationPmax.getAttribute("aria-invalid") === "true") {
      nodes.simulationPmax.value = editableNumber(nodes.pmax.value);
      nodes.simulationPmax.removeAttribute("aria-invalid");
    } else {
      nodes.simulationPmax.value = editableNumber(nodes.pmax.value);
    }
  });
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
  nodes.detailZoom.addEventListener("change", () => {
    if (lastResult) renderChart(lastResult);
  });
  nodes.colorContrast.addEventListener("change", () => {
    applyColorContrast();
    renderMethodList();
    renderParameters();
    if (lastResult) renderChart(lastResult);
  });
  nodes.resetDetailZoom.addEventListener("click", () => {
    detailZoomCustom = false;
    detailZoomBounds = lastResult ? automaticDetailBounds(lastResult) : null;
    if (lastResult) renderChart(lastResult);
    nodes.detailZoom.focus();
  });
  $("#restore-case").addEventListener("click", restoreCase);
  $("#restore-case-secondary").addEventListener("click", restoreCase);
  nodes.discardSimulation.addEventListener("click", restoreCase);
  nodes.startSimulation.addEventListener("click", () => {
    rankingBeforeCopy = rankingMode;
    simulationActive = true;
    rankingMode = "total";
    syncRankingButtons();
    renderCaseStrip();
    renderSimulationPanel();
    if (lastResult) {
      renderPermanentResults(lastResult);
      renderImpact(lastResult);
      renderConclusions(lastResult);
    }
    nodes.technicalFields.querySelector("input")?.focus();
  });
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
      syncRankingButtons();
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
  nodes.reportOpen.addEventListener("click", openReportPreview);
  nodes.reportClose.addEventListener("click", closeReportPreview);
  nodes.reportPrint.addEventListener("click", printReport);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("is-report-open")) {
      closeReportPreview();
    }
  });
  window.addEventListener("click", (event) => {
    const inOwnerArea = event.clientX >= window.innerWidth - 72
      && event.clientY >= window.innerHeight * 0.36
      && event.clientY <= window.innerHeight * 0.64;
    if (!inOwnerArea || event.detail !== 3) return;
    try {
      window.localStorage.setItem(reportWatermarkPreference, "1");
    } catch (_error) {
      return;
    }
    document.body.classList.add("fp-report-owner");
  }, true);
  document.documentElement.dataset.formulaAppReady = "true";
})();
