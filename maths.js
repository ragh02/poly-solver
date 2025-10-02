let pyodideReady = false;

// Load Pyodide and SymPy
async function loadPyodideAndPackages() {
  try {
    window.pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.24.1/full/" });
    await pyodide.loadPackage(["sympy","numpy"]);
    pyodideReady = true;
    console.info("Pyodide + SymPy ready.");
  } catch (err) {
    console.error("Failed to load Pyodide or packages:", err);
    pyodideReady = false;
  }
}
loadPyodideAndPackages();

/* ---------- parser  ---------- */
function parseExpression(expr) {
  if (typeof expr !== "string") return expr;
  let parsed = expr.trim();
  parsed = parsed.replace(/\^/g, "**");
  parsed = parsed.replace(/(\d)([a-zA-Z])/g, "$1*$2");
  parsed = parsed.replace(/(\))(\s*[a-zA-Z0-9])/g, "$1*$2");
  parsed = parsed.replace(/(\d)(\s*\()/g, "$1*(");
  parsed = parsed.replace(/\)\s*\(/g, ")*(");
  parsed = parsed.replace(/\s+/g, " ");
  if (parsed.includes("=")) parsed = parsed.replace(/\s*=\s*/, "-(") + ")";
  return parsed;
}

/* ---------- ensurePlotlyLoaded ---------- */
function ensurePlotlyLoaded(timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    if (window.Plotly) { console.info("Plotly present"); return resolve(); }
    const start = Date.now();
    const check = setInterval(() => {
      if (window.Plotly) { clearInterval(check); console.info("Plotly loaded"); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(check); reject(new Error("Plotly did not load")); }
    }, 50);
  });
}

/* ---------- computeXYWithPyodide ----------
   Returns { xs: [...], ys: [...] } where ys items are numbers or null
*/
async function computeXYWithPyodide(exprParsed, xMin = -10, xMax = 10, points = 400) {
  if (!pyodideReady) throw new Error("Pyodide not ready");

  // bind expression safely
  pyodide.globals.set("user_expr", exprParsed);

  const pyCode = `
from sympy import symbols, sympify, lambdify
import numpy as _np, json
x = symbols('x')
expr = sympify(user_expr, locals={'x': x})
f = lambdify(x, expr, "numpy")
xs = _np.linspace(${xMin}, ${xMax}, ${points})
ys_raw = f(xs)
ys = []
for v in ys_raw:
    try:
        ys.append(float(v))
    except Exception:
        ys.append(None)
result = json.dumps({'xs': xs.tolist(), 'ys': ys})
result
`;

  try {
    const pyResult = await pyodide.runPythonAsync(pyCode);

    // pyResult might be a JS string or a PyProxy - coerce to string safely
    const jsonStr = (typeof pyResult === "string") ? pyResult : pyResult.toString();

    // parse JSON
    const obj = JSON.parse(jsonStr);

    // sanitize numbers: NaN/Infinity -> null
    obj.ys = obj.ys.map(v => {
      if (v === null) return null;
      const n = Number(v);
      if (!isFinite(n) || Number.isNaN(n)) return null;
      return n;
    });

    return obj;
  } finally {
    try { pyodide.globals.del("user_expr"); } catch (e) { /* ignore */ }
  }
}

/* ---------- runSympyCommand ---------- */
async function runSympyCommand(exprParsed, command) {
  if (!pyodideReady) throw new Error("Pyodide not ready");

  pyodide.globals.set("user_expr", exprParsed);

  let commandBody = "";
  switch (command) {
    case "solve":
      commandBody = `
roots = solve(expr, x)
result_str = latex(Matrix(roots))
`;
      break;
    case "solvenumeric":
      commandBody = `
roots = solve(expr, x)
numeric_roots = [N(r) for r in roots]
result_str = latex(Matrix(numeric_roots))
`;
      break;
    case "evaluate":
      commandBody = `result_str = latex(expr.evalf())\n`;
      break;
    case "factor":
      commandBody = `result_str = latex(factor(expr))\n`;
      break;
    case "diff":
      commandBody = `result_str = latex(diff(expr, x))\n`;
      break;
    case "integrate":
      commandBody = `result_str = latex(integrate(expr, x))\n`;
      break;
    case "simplify":
      commandBody = `result_str = latex(simplify(expr))\n`;
      break;
    case "expand":
      commandBody = `result_str = latex(expand(expr))\n`;
      break;
    case "graph":
      commandBody = `# graph handled separately\nresult_str = "GRAPH_COMMAND"\n`;
      break;
    default:
      commandBody = `result_str = "Unknown command: ${command}"\n`;
      break;
  }

  const code = `
from sympy import symbols, solve, diff, integrate, simplify, expand, factor, N, sympify, latex, Matrix
x = symbols('x')
expr = sympify(user_expr, locals={'x': x})
result_str = ""
try:
${commandBody.replace(/^/gm, "    ")}
except Exception as e:
    result_str = "Error: " + str(e)
result_str
`;

  try {
    const result = await pyodide.runPythonAsync(code);
    return (typeof result === "string") ? result : result.toString();
  } finally {
    try { pyodide.globals.del("user_expr"); } catch (e) { /* ignore */ }
  }
}

/* ---------- plotExpression ---------- */
async function plotExpression(exprParsed) {
  const outputDiv = document.getElementById("output");
  const graphDiv = document.getElementById("graph");

  if (!graphDiv) {
    console.error("Missing #graph element");
    if (outputDiv) outputDiv.innerText = "Plot container missing in DOM.";
    return false;
  }

  try {
    await ensurePlotlyLoaded();
  } catch (err) {
    console.error("Plotly not loaded:", err);
    if (outputDiv) outputDiv.innerText = "Plotly failed to load.";
    return false;
  }

  if (outputDiv) outputDiv.innerText = "Generating graph - please wait...";

  let obj;
  try {
    obj = await computeXYWithPyodide(exprParsed, -10, 10, 600);
  } catch (err) {
    console.error("computeXYWithPyodide error:", err);
    if (outputDiv) outputDiv.innerText = "Could not graph the equation. Make sure that your function only contains Xs, no other variables! (all graphs automatically make y equal the function) (see console for more info)";
    graphDiv.style.height = "1px";
    graphDiv.innerHTML = "";
    return false;
  }

  if (!obj || !Array.isArray(obj.xs) || !Array.isArray(obj.ys)) {
    console.error("Invalid plotting payload:", obj);
    if (outputDiv) outputDiv.innerText = "Could not graph the equation. Data incorrect";
    graphDiv.style.height = "1px";
    graphDiv.innerHTML = "";
    return false;
  }

  const hasNumeric = obj.ys.some(v => v !== null);
  if (!hasNumeric) {
    if (outputDiv) outputDiv.innerText = "Function evaluates to non-real values on this range.";
    graphDiv.style.height = "1px";
    graphDiv.innerHTML = "";
    return false;
  }

// collapse first
graphDiv.style.height = "1px";
graphDiv.innerHTML = "";

// trigger expansion
requestAnimationFrame(() => {
    graphDiv.style.height = "400px";

    // wait for the CSS transition to finish (400ms + small buffer)
    setTimeout(() => {
        // now render Plotly safely in fully expanded container
        Plotly.newPlot(graphDiv, [trace], layout, { responsive: true });
        if (outputDiv) outputDiv.innerText = "Graph generated below.";
    }, 450); // 400ms + 50ms buffer
});



  // Build trace & layout 
  const trace = { x: obj.xs, y: obj.ys, mode: "lines", type: "scatter", name: exprParsed, connectgaps: false };
  const layout = {
    title: `Graph of ${exprParsed}`,
    xaxis: { title: "x" },
    yaxis: { title: "y" },
    margin: { t: 40, b: 40 }
  };

  const config = {
    responsive: true,
    staticPlot: false,            
    displayModeBar: true,        
    scrollZoom: false,           
    modeBarButtonsToRemove: ['zoom2d','zoomIn2d','zoomOut2d','pan2d']
  };

  try {
    // v3-compatible call
    Plotly.newPlot(graphDiv, [trace], layout, config);
    if (outputDiv) outputDiv.innerText = "Graph generated below.";
    return true;
  } catch (err) {
    console.error("Plotly.newPlot error:", err);
    if (outputDiv) outputDiv.innerText = "A rendering error occured (see console).";
    graphDiv.style.height = "400px";
    graphDiv.innerHTML = "";
    return false;
  }
}

/* ---------- main UI function ---------- */
async function doMaths() {
  const outputDiv = document.getElementById("output");
  const graphDiv = document.getElementById("graph");

  if (!pyodideReady) { alert("The calculator is still loading. Please wait."); return; }

  const raw = (document.getElementById("box") || {}).value || "";
  const exprRaw = raw.trim();
  if (!exprRaw) { if (outputDiv) outputDiv.innerText = "Enter an equation!"; return; }

  const exprParsed = parseExpression(exprRaw);
  const command = (document.getElementById("command") || {}).value || "solve";

  try {
    if (command === "graph") {
      // compute & plot graph (auto-expands)
      await plotExpression(exprParsed);
      return;
    }

    // non-graph commands -> collapse graph if currently open
    if (graphDiv && graphDiv.style.height !== "1px") {
      graphDiv.style.height = "1px";   // collapse smoothly
      // optionally clear old plot
      setTimeout(() => { graphDiv.innerHTML = ""; }, 400);
    }

    // run sympy
    if (outputDiv) outputDiv.innerText = "Computing - please wait...";
    const result = await runSympyCommand(exprParsed, command);

    if (typeof result === "string" && result.startsWith("Error:")) {
      if (outputDiv) outputDiv.innerText = result;
      return;
    }

    if (outputDiv) {
      outputDiv.innerHTML = "$$" + result + "$$";
      try { MathJax.typeset(); } catch (e) { /* ignore */ }
    }

  } catch (err) {
    console.error("doMaths error:", err);
    if (outputDiv) outputDiv.innerText = "An error occured. (see console for more details).";
  }
}


/* expose for debugging */
window.parseExpression = parseExpression;
window.doMaths = doMaths;
window.plotExpression = plotExpression;
window.computeXYWithPyodide = computeXYWithPyodide;
window.runSympyCommand = runSympyCommand;
