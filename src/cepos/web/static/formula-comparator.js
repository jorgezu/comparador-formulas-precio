(() => {
  "use strict";

  const catalogNode = document.querySelector("#formula-catalog");
  const workspace = document.querySelector("#formula-workspace");
  if (!catalogNode || !workspace) return;

  const catalog = JSON.parse(catalogNode.textContent);
  const colors = ["#087f8c", "#c84556", "#3568b8", "#d58c1d", "#3d7f58", "#785c99", "#8b5a3c"];
  const methodColors = new Map(catalog.methods.map((method, index) => [method.method_id, colors[index % colors.length]]));
  const euro = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  const score = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 3, minimumFractionDigits: 0 });
  const percent = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: 0 });
  const svgNamespace = "http://www.w3.org/2000/svg";

  const tenderInput = document.querySelector("#tender-price");
  const pmaxInput = document.querySelector("#pmax");
  const offerList = document.querySelector("#offer-list");
  const offerCount = document.querySelector("#offer-count");
  const methodList = document.querySelector("#method-list");
  const resultStatus = document.querySelector("#result-status");
  const rangeGrid = document.querySelector("#range-grid");
  const resultsHead = document.querySelector("#results-head");
  const resultsBody = document.querySelector("#results-body");
  const tableNote = document.querySelector("#table-note");
  const impactList = document.querySelector("#impact-list");
  const changeSummary = document.querySelector("#change-summary");
  const advancedGrid = document.querySelector("#advanced-grid");
  const explanations = document.querySelector("#formula-explanations");
  const chart = document.querySelector("#result-chart");
  const chartLegend = document.querySelector("#chart-legend");
  const variantPicker = document.querySelector("#variant-picker");
  const variantFamily = document.querySelector("#variant-family");
  const downloadButton = document.querySelector("#download-csv");

  let offers = [];
  let baseline = null;
  let lastResult = null;
  let requestController = null;
  let debounceTimer = null;
  let offerSequence = 0;
  let chartMode = "offers";

  const deepCopy = (value) => JSON.parse(JSON.stringify(value));

  const element = (name, className, text) => {
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
    resultStatus.textContent = message;
    resultStatus.classList.toggle("is-error", kind === "error");
    resultStatus.classList.toggle("is-loading", kind === "loading");
  };

  const nextOfferName = () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const index = offers.length;
    return index < alphabet.length ? alphabet[index] : `O${index + 1}`;
  };

  const newOfferId = () => {
    offerSequence += 1;
    return `offer-user-${Date.now()}-${offerSequence}`;
  };

  const currentScenario = () => ({
    tender_price: Number(tenderInput.value),
    pmax: Number(pmaxInput.value),
    offers: offers.map((item) => ({ ...item })),
  });

  const renderOffers = () => {
    offerCount.textContent = `${offers.length} de ${catalog.max_offers}`;
    offerList.replaceChildren(...offers.map((offer, index) => {
      const row = element("div", "fp-offer-row");
      row.dataset.offerId = offer.offer_id;

      const nameInput = element("input", "fp-offer-name");
      nameInput.type = "text";
      nameInput.maxLength = 40;
      nameInput.value = offer.name;
      nameInput.setAttribute("aria-label", `Nombre de la oferta ${index + 1}`);
      nameInput.addEventListener("input", () => {
        offer.name = nameInput.value;
        scheduleCompare();
      });

      const priceInput = element("input", "fp-offer-price");
      priceInput.type = "number";
      priceInput.inputMode = "decimal";
      priceInput.min = "0.01";
      priceInput.step = "1000";
      priceInput.value = String(offer.price);
      priceInput.setAttribute("aria-label", `Precio de ${offer.name || `oferta ${index + 1}`}`);
      priceInput.addEventListener("input", () => {
        offer.price = Number(priceInput.value);
        scheduleCompare();
      });

      const remove = element("button", "fp-remove-offer", "×");
      remove.type = "button";
      remove.title = `Eliminar ${offer.name || `oferta ${index + 1}`}`;
      remove.setAttribute("aria-label", remove.title);
      remove.disabled = offers.length <= 2;
      remove.addEventListener("click", () => {
        offers = offers.filter((item) => item.offer_id !== offer.offer_id);
        renderOffers();
        scheduleCompare(0);
      });

      row.append(nameInput, priceInput, remove);
      return row;
    }));
    document.querySelector("#add-offer").disabled = offers.length >= catalog.max_offers;
  };

  const initialParameterValue = (method, field) => {
    const selected = method.variants.find((variant) => variant.variant_id === method.default_variant_id) || method.variants[0];
    const value = selected.parameters[field.name];
    return Number(value) * Number(field.display_factor || 1);
  };

  const renderMethods = (selectionState = null) => {
    methodList.replaceChildren(...catalog.methods.map((method) => {
      const saved = selectionState?.[method.method_id];
      const selected = saved ? saved.selected : method.default_selected;
      const selectedVariant = saved?.variant_id || method.default_variant_id;
      const row = element("div", "fp-method-row");
      row.dataset.methodId = method.method_id;

      const label = element("label", "fp-method-main");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected;
      checkbox.dataset.role = "method-check";
      const copy = element("span");
      copy.append(
        element("strong", "", method.name),
        element("small", "", method.depends_on_other_offers ? `Depende de: ${method.dependency}` : "No depende del resto de ofertas")
      );
      label.append(checkbox, copy);
      row.append(label);

      const options = element("div", "fp-method-options");
      options.hidden = !selected || (!method.parameter_fields.length && method.variants.length === 1);
      const select = element("select");
      select.dataset.role = "variant-select";
      select.setAttribute("aria-label", `Variante de ${method.name}`);
      method.variants.forEach((variant) => {
        const option = element("option", "", variant.label);
        option.value = variant.variant_id;
        option.selected = variant.variant_id === selectedVariant;
        select.append(option);
      });
      if (method.parameter_fields.length) {
        const customOption = element("option", "", "Introducir otros valores");
        customOption.value = "custom";
        customOption.selected = selectedVariant === "custom";
        select.append(customOption);
      }
      options.append(select);

      const custom = element("div", "fp-custom-parameters");
      custom.dataset.role = "custom-parameters";
      custom.hidden = selectedVariant !== "custom";
      method.parameter_fields.forEach((field) => {
        const fieldLabel = element("label", "fp-custom-field");
        const labelText = `${field.label}${field.suffix ? ` (${field.suffix})` : ""}`;
        fieldLabel.append(element("span", "", labelText));
        const input = element("input");
        input.type = "number";
        input.inputMode = "decimal";
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step);
        input.dataset.parameter = field.name;
        input.dataset.displayFactor = String(field.display_factor || 1);
        const savedValue = saved?.parameters?.[field.name];
        input.value = String(savedValue !== undefined ? savedValue * Number(field.display_factor || 1) : initialParameterValue(method, field));
        fieldLabel.append(input);
        custom.append(fieldLabel);
      });
      custom.append(element("p", "fp-custom-origin", "Valores libres introducidos por el usuario; no son una variante documentada."));
      options.append(custom);
      row.append(options);

      checkbox.addEventListener("change", () => {
        options.hidden = !checkbox.checked || (!method.parameter_fields.length && method.variants.length === 1);
        scheduleCompare(0);
      });
      select.addEventListener("change", () => {
        custom.hidden = select.value !== "custom";
        if (select.value === "custom") setMode("advanced");
        scheduleCompare(0);
      });
      custom.querySelectorAll("input").forEach((input) => input.addEventListener("input", () => scheduleCompare()));
      return row;
    }));
  };

  const selectedMethods = () => {
    const selections = [];
    methodList.querySelectorAll(".fp-method-row").forEach((row) => {
      const checkbox = row.querySelector('[data-role="method-check"]');
      if (!checkbox.checked) return;
      const select = row.querySelector('[data-role="variant-select"]');
      const variantId = select?.value || catalog.methods.find((method) => method.method_id === row.dataset.methodId).default_variant_id;
      const selection = { method_id: row.dataset.methodId, variant_id: variantId };
      if (variantId === "custom") {
        selection.parameters = {};
        row.querySelectorAll("[data-parameter]").forEach((input) => {
          selection.parameters[input.dataset.parameter] = Number(input.value) / Number(input.dataset.displayFactor || 1);
        });
      }
      selections.push(selection);
    });
    return selections;
  };

  const currentMethodState = () => {
    const state = {};
    methodList.querySelectorAll(".fp-method-row").forEach((row) => {
      const select = row.querySelector('[data-role="variant-select"]');
      const parameters = {};
      row.querySelectorAll("[data-parameter]").forEach((input) => {
        parameters[input.dataset.parameter] = Number(input.value) / Number(input.dataset.displayFactor || 1);
      });
      state[row.dataset.methodId] = {
        selected: row.querySelector('[data-role="method-check"]').checked,
        variant_id: select?.value,
        parameters,
      };
    });
    return state;
  };

  const scheduleCompare = (delay = 350) => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(compareNow, delay);
  };

  const compareNow = async () => {
    const methods = selectedMethods();
    if (!methods.length) {
      setStatus("Selecciona al menos una fórmula para comparar.", "error");
      return;
    }
    if (requestController) requestController.abort();
    requestController = new AbortController();
    setStatus("Recalculando con el motor validado...", "loading");
    document.querySelector("#compare-button").disabled = true;
    try {
      const payload = { ...currentScenario(), methods };
      if (baseline) payload.baseline = baseline;
      const response = await fetch(catalog.api_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: requestController.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "No se pudo calcular el escenario.");
      lastResult = result;
      renderResult(result);
      setStatus(`${result.scenario.offer_count} ofertas · ${result.methods.length} fórmulas · resultados actualizados`);
      downloadButton.disabled = false;
    } catch (error) {
      if (error.name !== "AbortError") {
        setStatus(error.message, "error");
        downloadButton.disabled = true;
      }
    } finally {
      document.querySelector("#compare-button").disabled = false;
    }
  };

  const renderResult = (result) => {
    renderImpacts(result);
    renderRanges(result);
    renderTable(result);
    renderAdvanced(result);
    renderExplanations(result);
    populateVariantPicker(result);
    renderChart(result);
  };

  const renderImpacts = (result) => {
    const contextLabels = {
      ONLY_OFFER_SET: "La referencia conserva los mismos precios comunes; se ha añadido o eliminado alguna oferta.",
      OFFER_PRICES_CHANGED: "Se comparan los precios actuales con la situación fijada como referencia.",
      TENDER_OR_PMAX_CHANGED: "También ha cambiado el presupuesto o la puntuación máxima respecto de la referencia.",
    };
    if (!result.impacts.length) {
      changeSummary.textContent = "Fija una situación de referencia para medir los cambios posteriores.";
      impactList.replaceChildren();
      return;
    }
    const unchangedChanges = result.impacts.reduce((sum, item) => sum + item.unchanged_price_changed_count, 0);
    changeSummary.textContent = unchangedChanges
      ? `${contextLabels[result.change_context]} Hay ${unchangedChanges} cambios de puntuación en ofertas cuyo precio no se ha modificado.`
      : `${contextLabels[result.change_context]} Ninguna oferta con el mismo precio ha cambiado de puntuación.`;
    impactList.replaceChildren(...result.impacts.map((impact) => {
      const hasChange = impact.unchanged_price_changed_count > 0;
      const item = element("div", `fp-impact-item ${hasChange ? "has-change" : "no-change"}`);
      item.append(
        element("strong", "", impact.name),
        element(
          "span",
          "",
          hasChange
            ? `${impact.unchanged_price_changed_count} sin cambiar precio · máximo ${score.format(impact.max_absolute_change)} pt`
            : "Sin cambios en ofertas de igual precio"
        )
      );
      return item;
    }));
  };

  const renderRanges = (result) => {
    rangeGrid.replaceChildren(...result.methods.map((method) => {
      const card = element("article", "fp-range-card");
      card.style.setProperty("--series-color", methodColors.get(method.method_id));
      card.style.setProperty("--range-width", `${Math.min(100, method.effective_range_ratio * 100)}%`);
      card.append(
        element("strong", "", method.short_name),
        element("span", "fp-range-value", `${score.format(method.effective_score_range)} pt`),
        element("small", "", `${percent.format(method.effective_range_ratio * 100)} % de los ${number.format(result.scenario.pmax)} puntos nominales`)
      );
      const bar = element("div", "fp-range-bar");
      bar.append(element("i"));
      card.append(bar);
      return card;
    }));
  };

  const impactDeltas = (result) => {
    const values = new Map();
    result.impacts.forEach((impact) => {
      impact.changes.forEach((change) => values.set(`${impact.method_id}:${change.offer_id}`, change.delta));
    });
    return values;
  };

  const renderTable = (result) => {
    const headerRow = element("tr");
    ["Oferta", "Precio", "Baja"].forEach((label) => headerRow.append(element("th", "", label)));
    result.methods.forEach((method) => {
      const th = element("th", "", method.short_name);
      th.title = method.name;
      headerRow.append(th);
    });
    resultsHead.replaceChildren(headerRow);

    const deltas = impactDeltas(result);
    resultsBody.replaceChildren(...result.rows.map((row) => {
      const tr = element("tr");
      tr.append(
        element("td", "", row.name),
        element("td", "", euro.format(row.price)),
        element("td", "", `${percent.format(row.discount_pct)} %`)
      );
      result.methods.forEach((method) => {
        const td = element("td");
        td.append(element("span", "fp-score", score.format(row.scores[method.method_id])));
        const key = `${method.method_id}:${row.offer_id}`;
        if (deltas.has(key) && Math.abs(deltas.get(key)) > 1e-9) {
          const delta = deltas.get(key);
          const kind = delta > 0 ? "positive" : "negative";
          const sign = delta > 1e-9 ? "+" : "";
          td.append(element("span", `fp-delta ${kind}`, `${sign}${score.format(delta)} pt`));
        } else if (baseline && !baseline.offers.some((item) => item.offer_id === row.offer_id)) {
          td.append(element("span", "fp-delta neutral", "Nueva"));
        }
        tr.append(td);
      });
      return tr;
    }));
    tableNote.textContent = "Las variaciones se muestran respecto de la referencia fijada.";
  };

  const renderAdvanced = (result) => {
    advancedGrid.replaceChildren(...result.methods.map((method) => {
      const item = element("article", "fp-advanced-item");
      item.append(element("h4", "", method.name));
      const dl = element("dl");
      const entries = [
        ["Variante", method.parameter_origin === "DOCUMENTED" ? "Documentada" : "Valores libres"],
        ["Dependencia", method.dependency],
        ["Curvatura", method.behavior],
        ["Desviación", `${score.format(method.score_stddev)} pt`],
        ["Sensibilidad media", `${score.format(method.sensitivity_points_per_one_percent)} pt / 1 % PL`],
      ];
      entries.forEach(([term, value]) => {
        dl.append(element("dt", "", term), element("dd", "", value));
      });
      item.append(dl);
      return item;
    }));
  };

  const renderExplanations = (result) => {
    const selected = new Map(result.methods.map((method) => [method.method_id, method]));
    explanations.replaceChildren(...catalog.methods.map((catalogMethod) => {
      const method = selected.get(catalogMethod.method_id) || catalogMethod;
      const details = element("details", "fp-formula-item");
      const summary = element("summary");
      summary.append(
        element("strong", "", catalogMethod.name),
        element("span", "", catalogMethod.dependency)
      );
      const content = element("div", "fp-formula-content");
      content.append(element("p", "", catalogMethod.description));
      const properties = element("div", "fp-formula-properties");
      properties.append(
        element("span", "", `Depende de otras ofertas: ${catalogMethod.depends_on_other_offers ? "Sí" : "No"}`),
        element("span", "", `Comportamiento: ${catalogMethod.behavior}`),
        element("code", "", catalogMethod.expression),
        element("code", "", `Identificador técnico: ${catalogMethod.method_id}`)
      );
      if (method.variant_label) properties.append(element("span", "", method.variant_label));
      content.append(properties);
      details.append(summary, content);
      return details;
    }));
  };

  const populateVariantPicker = (result) => {
    const previous = variantFamily.value;
    variantFamily.replaceChildren(...result.variant_comparisons.map((family) => {
      const option = element("option", "", family.name);
      option.value = family.method_id;
      return option;
    }));
    if (result.variant_comparisons.some((family) => family.method_id === previous)) variantFamily.value = previous;
  };

  const clearChart = () => {
    chart.querySelectorAll(":scope > :not(title):not(desc)").forEach((node) => node.remove());
    chartLegend.replaceChildren();
  };

  const chartText = (x, y, value, anchor = "middle") => {
    const text = svgElement("text", { x, y, "text-anchor": anchor, class: "fp-chart-label" });
    text.textContent = value;
    chart.append(text);
  };

  const linePath = (points) => points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");

  const drawAxes = ({ xMin, xMax, yMin, yMax, xLabel, yLabel, xFormat, yFormat }) => {
    const width = 920;
    const height = 430;
    const margin = { left: 72, right: 24, top: 24, bottom: 58 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const safeXMax = xMax === xMin ? xMin + 1 : xMax;
    const safeYMax = yMax === yMin ? yMin + 1 : yMax;
    const x = (value) => margin.left + ((value - xMin) / (safeXMax - xMin)) * plotWidth;
    const y = (value) => margin.top + plotHeight - ((value - yMin) / (safeYMax - yMin)) * plotHeight;
    for (let index = 0; index <= 4; index += 1) {
      const xValue = xMin + ((safeXMax - xMin) * index / 4);
      const yValue = yMin + ((safeYMax - yMin) * index / 4);
      chart.append(svgElement("line", { x1: x(xValue), y1: margin.top, x2: x(xValue), y2: margin.top + plotHeight, class: "fp-chart-grid" }));
      chart.append(svgElement("line", { x1: margin.left, y1: y(yValue), x2: margin.left + plotWidth, y2: y(yValue), class: "fp-chart-grid" }));
      chartText(x(xValue), height - 35, xFormat(xValue));
      chartText(margin.left - 10, y(yValue) + 4, yFormat(yValue), "end");
    }
    chart.append(
      svgElement("line", { x1: margin.left, y1: margin.top + plotHeight, x2: margin.left + plotWidth, y2: margin.top + plotHeight, class: "fp-chart-axis" }),
      svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotHeight, class: "fp-chart-axis" })
    );
    chartText(margin.left + plotWidth / 2, height - 8, xLabel);
    const yTitle = svgElement("text", { x: 17, y: margin.top + plotHeight / 2, transform: `rotate(-90 17 ${margin.top + plotHeight / 2})`, "text-anchor": "middle", class: "fp-chart-label" });
    yTitle.textContent = yLabel;
    chart.append(yTitle);
    return { x, y };
  };

  const addLegend = (series) => {
    chartLegend.replaceChildren(...series.map((item, index) => {
      const legend = element("span", "fp-legend-item");
      const swatch = element("i", "fp-legend-swatch");
      swatch.style.setProperty("--series-color", item.color || colors[index % colors.length]);
      legend.append(swatch, element("span", "", item.name));
      return legend;
    }));
  };

  const plotSeries = (series, x, y, pointRadius = 3.5) => {
    series.forEach((item, index) => {
      const color = item.color || colors[index % colors.length];
      const path = svgElement("path", { d: linePath(item.points.map((point) => [x(point.x), y(point.y)])), class: "fp-chart-line" });
      path.style.setProperty("--series-color", color);
      chart.append(path);
      item.points.forEach((point) => {
        const circle = svgElement("circle", { cx: x(point.x), cy: y(point.y), r: pointRadius, class: "fp-chart-point" });
        circle.style.setProperty("--series-color", color);
        const title = svgElement("title");
        title.textContent = `${item.name}: ${score.format(point.y)}`;
        circle.append(title);
        chart.append(circle);
      });
    });
    addLegend(series);
  };

  const renderChart = (result) => {
    clearChart();
    variantPicker.hidden = chartMode !== "variants";
    if (chartMode === "offers") {
      const maxIndex = Math.max(1, result.rows.length - 1);
      const axes = drawAxes({
        xMin: 0,
        xMax: maxIndex,
        yMin: 0,
        yMax: result.scenario.pmax,
        xLabel: "Ofertas",
        yLabel: "Puntuación",
        xFormat: (value) => result.rows[Math.min(result.rows.length - 1, Math.round(value))]?.name || "",
        yFormat: (value) => number.format(value),
      });
      const series = result.methods.map((method) => ({
        name: method.short_name,
        color: methodColors.get(method.method_id),
        points: result.rows.map((row, index) => ({ x: index, y: row.scores[method.method_id] })),
      }));
      plotSeries(series, axes.x, axes.y, 4.2);
      return;
    }
    if (chartMode === "price") {
      const allPoints = result.curves.flatMap((item) => item.points);
      const prices = allPoints.map((point) => point.price);
      const axes = drawAxes({
        xMin: Math.min(...prices),
        xMax: Math.max(...prices),
        yMin: 0,
        yMax: result.scenario.pmax,
        xLabel: "Precio ofertado",
        yLabel: "Puntuación",
        xFormat: (value) => `${number.format(value / 1000)}k`,
        yFormat: (value) => number.format(value),
      });
      plotSeries(result.curves.map((curve) => ({
        name: curve.name,
        color: methodColors.get(curve.method_id),
        points: curve.points.map((point) => ({ x: point.price, y: point.score })),
      })), axes.x, axes.y, 1.8);
      return;
    }
    if (chartMode === "discount") {
      const allPoints = result.curves.flatMap((item) => item.points);
      const discounts = allPoints.map((point) => point.discount_pct);
      const axes = drawAxes({
        xMin: 0,
        xMax: Math.max(...discounts),
        yMin: 0,
        yMax: 100,
        xLabel: "Baja sobre el presupuesto",
        yLabel: "% de la puntuación máxima",
        xFormat: (value) => `${percent.format(value)} %`,
        yFormat: (value) => `${number.format(value)} %`,
      });
      plotSeries(result.curves.map((curve) => ({
        name: curve.name,
        color: methodColors.get(curve.method_id),
        points: curve.points.map((point) => ({ x: point.discount_pct, y: point.score_pct })),
      })), axes.x, axes.y, 1.8);
      return;
    }

    const selectedFamily = result.variant_comparisons.find((family) => family.method_id === variantFamily.value) || result.variant_comparisons[0];
    if (!selectedFamily) {
      chartText(460, 205, "Selecciona una familia con varias variantes documentadas.");
      return;
    }
    variantFamily.value = selectedFamily.method_id;
    const allPoints = selectedFamily.series.flatMap((item) => item.points);
    const axes = drawAxes({
      xMin: 0,
      xMax: Math.max(...allPoints.map((point) => point.discount_pct)),
      yMin: 0,
      yMax: 100,
      xLabel: "Baja sobre el presupuesto",
      yLabel: "% de la puntuación máxima",
      xFormat: (value) => `${percent.format(value)} %`,
      yFormat: (value) => `${number.format(value)} %`,
    });
    plotSeries(selectedFamily.series.map((item, index) => ({
      name: item.label,
      color: colors[index % colors.length],
      points: item.points.map((point) => ({ x: point.discount_pct, y: point.score_pct })),
    })), axes.x, axes.y, 1.8);
  };

  const setMode = (mode) => {
    workspace.dataset.mode = mode;
    document.querySelectorAll(".fp-mode-switch button").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  const loadDemo = () => {
    tenderInput.value = String(catalog.demo.tender_price);
    pmaxInput.value = String(catalog.demo.pmax);
    offers = deepCopy(catalog.demo.offers);
    baseline = deepCopy(catalog.demo);
    renderOffers();
    renderMethods();
    scheduleCompare(0);
  };

  const downloadCsv = () => {
    if (!lastResult) return;
    const headers = ["Oferta", "Precio", "Baja (%)", ...lastResult.methods.map((method) => method.name)];
    const decimal = (value) => Number(value).toFixed(6).replace(".", ",");
    const safe = (value) => {
      let text = String(value);
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = lastResult.rows.map((row) => [
      row.name,
      decimal(row.price),
      decimal(row.discount_pct),
      ...lastResult.methods.map((method) => decimal(row.scores[method.method_id])),
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(safe).join(";")).join("\r\n")}`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "comparacion-formulas-precio.csv";
    document.body.append(link);
    link.click();
    URL.revokeObjectURL(link.href);
    link.remove();
  };

  document.querySelector("#add-offer").addEventListener("click", () => {
    if (offers.length >= catalog.max_offers) return;
    const tender = Number(tenderInput.value) || 1_000_000;
    const lastPrice = offers.length ? Number(offers[offers.length - 1].price) : tender;
    offers.push({ offer_id: newOfferId(), name: nextOfferName(), price: Math.max(0.01, Math.min(tender, lastPrice - tender * 0.025)) });
    renderOffers();
    scheduleCompare(0);
  });

  document.querySelector("#add-extreme").addEventListener("click", () => {
    if (offers.length >= catalog.max_offers) return;
    const tender = Number(tenderInput.value) || 1_000_000;
    offers.push({ offer_id: newOfferId(), name: nextOfferName(), price: tender * 0.7 });
    renderOffers();
    scheduleCompare(0);
  });

  document.querySelector("#compare-button").addEventListener("click", compareNow);
  document.querySelector("#load-demo").addEventListener("click", loadDemo);
  document.querySelector("#set-baseline").addEventListener("click", () => {
    baseline = deepCopy(currentScenario());
    scheduleCompare(0);
  });
  tenderInput.addEventListener("input", () => scheduleCompare());
  pmaxInput.addEventListener("input", () => scheduleCompare());
  downloadButton.addEventListener("click", downloadCsv);

  document.querySelectorAll(".fp-mode-switch button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  document.querySelectorAll(".fp-chart-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      chartMode = button.dataset.chart;
      document.querySelectorAll(".fp-chart-tabs button").forEach((item) => item.setAttribute("aria-selected", String(item === button)));
      if (lastResult) renderChart(lastResult);
    });
  });
  variantFamily.addEventListener("change", () => lastResult && renderChart(lastResult));

  const feedbackButton = document.querySelector("#feedback-button");
  if (feedbackButton && catalog.feedback_url && /^(mailto:|https:)/.test(catalog.feedback_url)) {
    feedbackButton.addEventListener("click", () => window.location.assign(catalog.feedback_url));
  } else if (feedbackButton) {
    feedbackButton.hidden = true;
  }

  renderMethods(currentMethodState());
  loadDemo();
})();
