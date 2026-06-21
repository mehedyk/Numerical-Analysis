/* ====================================================================
   CORE — shared by every numerical method, regardless of type
   (bracketing, open, or interpolation).

   Anything in here doesn't know or care whether the active method is
   Bisection, Newton-Raphson, or Lagrange interpolation — it's pure
   plumbing: parsing what the user typed, formatting numbers, turning
   a results panel into a PNG/PDF, and the page-chrome behaviors
   (sidebar collapse, stop-option highlighting) that look the same no
   matter which method is selected.

   Method-specific engines (e.g. engine-bracketing.js) read from and
   attach to the single shared `window.NAW` namespace below, so this
   file must load *before* any engine file.
   ==================================================================== */
(function () {
  'use strict';

  const NAW = (window.NAW = window.NAW || {});

  /* ================================================================
     DOM REFERENCES
     A single shared lookup table, since most ids on the page (the
     form fields, status message, export buttons, etc.) are used by
     whichever engine is active. Engine files add their own extra
     ids onto this same object rather than keeping a separate one.
     ================================================================ */
  const $ = id => document.getElementById(id);
  const D = {
    fxInput:  $('fx-input'),
    aInput:   $('a-input'),
    bInput:   $('b-input'),
    trueIn:   $('true-root-input'),
    precisionIn: $('precision-input'),
    bracketHint: $('bracket-found-hint'),
    fineToggle: $('bracket-fine-toggle'),
    fxDot:    $('fx-validity'),
    statusMsg:$('status-msg'),
    heroGr:   $('hero-graph'),
    heroLbl:  $('hero-step-label'),
    heroSection: $('hero-section'),
    heroTitle: $('hero-title'),
    heroSubEl: $('hero-sub'),
    metaMethodVal: $('meta-method-val'),
    metaOrderVal:  $('meta-order-val'),
    metaNeedsVal:  $('meta-needs-val'),
    cReadingLabel: $('c-reading-label'),
    bisGr:    $('bisection-graph'),
    solSec:   $('solution-section'),
    vizSec:   $('viz-section'),
    tblSec:   $('table-section'),
    solBox:   $('sol-box'),
    readA:    $('read-a'),
    readB:    $('read-b'),
    readC:    $('read-c'),
    readFc:   $('read-fc'),
    readConv: $('read-converged'),
    readConvW:$('read-converged-wrap'),
    prevBtn:  $('step-prev'),
    nextBtn:  $('step-next'),
    playBtn:  $('play-pause'),
    speedSel: $('speed-select'),
    stepInd:  $('step-indicator'),
    tHead:    $('iter-thead-row'),
    tBody:    $('iter-tbody'),
    capSum:   $('capture-summary'),
    tblNote:  $('table-note'),
    expImg:   $('export-image-btn'),
    expPdf:   $('export-pdf-btn'),
  };
  NAW.$ = $;
  NAW.D = D;

  /* ================================================================
     PRECISION (shared state — every method's table/graph formats
     numbers through fmt()/fmtE() below, which read this)
     ================================================================ */
  let _precision = 4; // decimal places shown everywhere (user-adjustable, 1-8)
  NAW.getPrecision = () => _precision;
  NAW.setPrecision = v => { _precision = Math.min(8, Math.max(1, v)); };

  /* ================================================================
     MATH UTILITIES
     ================================================================ */
  /* mathjs natively defines log(x) as the NATURAL log and has no ln() at all.
     We want the opposite convention for this tool: log(x) = base-10,
     ln(x) = natural. Remap the two function names *after* the shorthand
     pre-processing has already expanded lnx → ln(x) and logx → log(x).
     The \blog\( pattern only matches a bare "log(" call — it cannot match
     "log10(" or "log2(" because the very next character has to be "(",
     so those are left untouched. */
  function remapLogNotation(expr) {
    return expr
      .replace(/\bln\(/g, '__LN_PLACEHOLDER__(')  // stash ln( calls
      .replace(/\blog\(/g, 'log10(')               // log(x)  -> base-10
      .replace(/__LN_PLACEHOLDER__\(/g, 'log(');   // ln(x)   -> mathjs's natural log
  }

  /* Parse a bound that may contain e, pi, sqrt(2), etc. */
  function parseVal(s) {
    if (!s || !s.trim()) return NaN;
    if (s.length > 200) return NaN;           // guard against oversized bound expressions
    try {
      const v = math.evaluate(remapLogNotation(s.trim()));
      return (typeof v === 'number' && isFinite(v)) ? v : NaN;
    } catch { return NaN; }
  }

  /* Pre-process a raw expression string to handle common shorthand notations:
     1. Function name applied to bare variable: logx → log(x), cosx → cos(x)
     2. Implicit multiplication before a function call: xtan(x) → x*tan(x), 2sin(x) → 2*sin(x) */
  function preprocessExpr(expr) {
    // Ordered longest-first so alternation matches correctly (log10 before log, asin before sin, etc.)
    const fnPat = 'asin|acos|atan|sinh|cosh|tanh|log10|log2|sin|cos|tan|log|ln|exp|sqrt|abs|ceil|floor|round';

    // Step 1: bare-variable function shorthand — sinx → sin(x), logx → log(x)
    // Matches: word-boundary + function name + single letter + word-boundary + NOT followed by '('
    expr = expr.replace(
      new RegExp('\\b(' + fnPat + ')\\s*([a-zA-Z])\\b(?!\\s*\\()', 'g'),
      '$1($2)'
    );

    // Step 2: implicit multiply before a function call — xtan( → x*tan(, 2sin( → 2*sin(
    // Matches: letter/digit immediately before a function name that is followed by '('
    expr = expr.replace(
      new RegExp('([a-zA-Z0-9])\\s*(' + fnPat + ')\\s*\\(', 'g'),
      '$1*$2('
    );

    return expr;
  }

  /* Compile f(x) expression into an evaluator */
  function compileFn(expr) {
    if (!expr || !expr.trim()) return null;
    try {
      const processed = remapLogNotation(preprocessExpr(expr.trim()));
      const node  = math.parse(processed);
      const scope = {};
      const fn = x => {
        scope.x = x;
        const r = node.evaluate(scope);
        return typeof r === 'number' ? r : NaN;
      };
      fn.valid = true;
      return fn;
    } catch { return null; }
  }

  /* Format a number for table display */
  function fmt(v, d = _precision) {
    if (v == null || isNaN(v) || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a > 0 && (a >= 1e7 || a < 1e-3)) return v.toExponential(d);
    return v.toFixed(d);
  }

  /* Scientific notation for error columns */
  function fmtE(v, d = _precision) {
    if (v == null || isNaN(v) || !isFinite(v)) return '—';
    return v.toExponential(d);
  }

  NAW.preprocessExpr   = preprocessExpr;
  NAW.remapLogNotation = remapLogNotation;
  NAW.compileFn = compileFn;
  NAW.parseVal  = parseVal;
  NAW.fmt  = fmt;
  NAW.fmtE = fmtE;

  /* ================================================================
     STATUS MESSAGES
     ================================================================ */
  /* Escape user-supplied strings before inserting into innerHTML.
     Covers both element content and attribute value contexts. */
  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
  }

  function showStatus(msg, type = 'error') {
    D.statusMsg.textContent = msg;
    D.statusMsg.className   = `status-msg ${type}`;
    D.statusMsg.hidden      = false;
  }
  function clearStatus() { D.statusMsg.hidden = true; }

  NAW.escHtml = escHtml;
  NAW.showStatus = showStatus;
  NAW.clearStatus = clearStatus;

  /* ================================================================
     EXPORT PLUMBING — generic capture/download mechanics
     (Building *what* goes in the export panel is method-specific and
     stays in each engine; turning a built panel into a PNG/PDF blob
     and triggering the download is identical for every method.)
     ================================================================ */
  function mkCaptureOverlay(label) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed','inset:0','z-index:99999',
      'background:rgba(8,23,41,0.93)',
      'display:flex','align-items:center','justify-content:center',
      'flex-direction:column','gap:10px'
    ].join(';');
    el.innerHTML = `
      <div style="font-family:monospace;font-size:13px;letter-spacing:2px;color:#C9784B">${label}</div>
      <div style="font-family:monospace;font-size:11px;color:#7B93B0">Building landscape report\u2026</div>`;
    document.body.appendChild(el);
    return el;
  }

  /* Wait for two animation frames so the browser fully paints
     the export element before html2canvas reads the pixels. */
  function waitFrames() {
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function ts() { return Date.now(); }

  function dl(blob, filename) {
    /* Validate MIME type before triggering download */
    if (!blob || !['image/png','application/pdf'].includes(blob.type)) return;
    const safeName = filename.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 80);
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = safeName; a.rel = 'noopener noreferrer'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function canvasBlob(canvas) {
    return new Promise(res => canvas.toBlob(res, 'image/png'));
  }

  NAW.mkCaptureOverlay = mkCaptureOverlay;
  NAW.waitFrames = waitFrames;
  NAW.ts = ts;
  NAW.dl = dl;
  NAW.canvasBlob = canvasBlob;

  /* ================================================================
     PAGE CHROME — behaviors identical no matter which method is active
     ================================================================ */

  /* Generic radio-group toggle (active-mode highlight), scoped to each
     fieldset's own .stop-options container so multiple radio groups
     on the page (stop-mode, bracket-mode, or any future method's own
     option group) don't interfere with each other */
  document.querySelectorAll('.stop-option input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const container = radio.closest('.stop-options');
      container.querySelectorAll('.stop-option').forEach(opt => {
        opt.classList.remove('active-mode');
        const sub = opt.querySelector('.sub-input');
        if (sub) sub.disabled = true;
      });
      const opt = radio.closest('.stop-option');
      opt.classList.add('active-mode');
      const sub = opt.querySelector('.sub-input');
      if (sub) { sub.disabled = false; sub.focus(); }
    });
  });
  /* Initialise disabled state */
  document.querySelectorAll('.stop-options').forEach(container => {
    container.querySelectorAll('.stop-option').forEach(opt => {
      const radio = opt.querySelector('input[type="radio"]');
      const sub   = opt.querySelector('.sub-input');
      if (radio?.checked) { opt.classList.add('active-mode'); if (sub) sub.disabled = false; }
      else if (sub)       sub.disabled = true;
    });
  });

  /* Sheet index toggle (desktop sidebar only — the mobile nav is a
     separate, always-compact element and isn't affected by this). */
  (function initSheetToggle() {
    const btn  = $('sheet-list-toggle');
    const list = $('sheet-list');
    if (!btn || !list) return;
    const STORAGE_KEY = 'nawSheetListHidden';

    function applyState(hidden) {
      list.classList.toggle('is-collapsed', hidden);
      btn.textContent = hidden ? 'Show' : 'Hide';
      btn.setAttribute('aria-expanded', String(!hidden));
    }

    let hidden = false;
    try { hidden = localStorage.getItem(STORAGE_KEY) === '1'; } catch {}
    applyState(hidden);

    btn.addEventListener('click', () => {
      hidden = !list.classList.contains('is-collapsed');
      applyState(hidden);
      try { localStorage.setItem(STORAGE_KEY, hidden ? '1' : '0'); } catch {}
    });
  })();

})();
