/* ====================================================================
   ENGINE — Bracketing methods (Bisection, False Position)
   ----------------------------------------------------------------------
   Everything specific to methods that work by narrowing a [a, b]
   bracket toward a root: the METHODS registry (one entry per method,
   holding just its copy + its formula for the next c), the shared
   bracketing solve loop, the bracket auto-finder, the table/graph/
   export rendering, and the method-switch UI wiring.

   Requires core.js to be loaded first (this file reads off the shared
   window.NAW namespace for math parsing, formatting, export plumbing,
   and DOM references).

   When Newton-Raphson / Secant / Fixed-point are added, they'll get
   their own engine-open.js sibling file (different input shape: a
   single starting guess instead of a bracket, no a/b bracket-mode
   controls, a different table shape) — they won't be bolted on here.
   ==================================================================== */
(function () {
  'use strict';

  /* Pull in everything shared from core.js (must be loaded first) */
  const NAW = window.NAW;
  const {
    $, D, compileFn, parseVal, fmt, fmtE,
    escHtml, showStatus, clearStatus,
    dl, ts, canvasBlob, mkCaptureOverlay, waitFrames,
  } = NAW;

  /* ================================================================
     STATE
     ================================================================ */
  let _steps   = [];
  let _idx     = 0;
  let _playTmr = null;
  let _heroTmr = null;
  let _fn      = null;   // compiled evaluator
  let _initA, _initB, _trueRoot;
  let _exIdx   = 0;
  let _activeMethod = 'bisection';

  /* ================================================================
     EXAMPLES
     ================================================================ */
  const EXAMPLES = [
    { fx: 'x^3 - x - 2',      a: '1',     b: '2',   note: 'Classic cubic — root ≈ 1.5214' },
    { fx: 'x^3 - 4*x - 9',    a: '2',     b: '3',   note: 'Cubic — root ≈ 2.7065' },
    { fx: '3x^3 - 7x + 5',    a: '-2',    b: '-1',  note: 'Cubic with negative bracket — root ≈ −1.834' },
    { fx: 'cos(x) - x',       a: '0',     b: '1',   note: 'Transcendental — root ≈ 0.7391' },
    { fx: 'exp(x) - 3*x',     a: '0',     b: '1',   note: 'Exponential — root ≈ 0.6190' },
    { fx: 'x^2 - 2',          a: '1',     b: '2',   note: '√2 — root ≈ 1.4142' },
    { fx: 'sin(x) - x/2',     a: '1',     b: '2',   note: 'Trig — root ≈ 1.8955' },
    { fx: 'x*tan(x) - 1',     a: '0',     b: '1',   note: 'x·tan(x) — root ≈ 0.8603' },
    { fx: 'ln(x) - cos(x)',   a: '1',     b: '2',   note: 'Natural log vs cosine — root ≈ 1.3029' },
    { fx: 'e^x - x^2 - 2',    a: '0',     b: '1',   note: 'Uses e constant — root ≈ 0.4428' },
  ];

  /* ================================================================
     METHODS
     Each entry holds everything that differs between bracketing
     methods: the on-screen copy, table/labels, and the formula for
     the next approximation. Everything else (form, bracket finder,
     stop criteria, export, table rendering) is shared.
     ================================================================ */
  const METHODS = {
    bisection: {
      id: 'bisection',
      num: '01',
      docTitle: 'Bisection Method',
      heroTitleHTML: 'Bisection method,<br>drawn out <span class="accent">step by step</span>.',
      heroSub: 'Give it an equation and a bracket, and watch the interval close in on the root — one halving at a time, with every approximation and error logged along the way.',
      metaMethod: 'Bisection (bracketing)',
      metaOrder: 'Linear convergence',
      metaNeeds: 'sign change on [a, b]',
      cLabel: 'c (midpoint)',
      cColHeader: 'c = (a+b)/2',
      aeFallbackNote: '(b − a) / 2  (guaranteed error bound)',
      graphAria: 'Plot of f(x) with the narrowing bisection bracket',
      heroGraphAria: 'Animated demo of the bisection method narrowing in on a root',
      needsMsg: 'Bisection needs f(a)·f(b) < 0.',
      nextC: (cA, cB, fa, fb) => (cA + cB) / 2,
    },
    falseposition: {
      id: 'falseposition',
      num: '02',
      docTitle: 'False Position Method',
      heroTitleHTML: 'False position method,<br>aimed by the <span class="accent">secant line</span>.',
      heroSub: 'Give it an equation and a bracket — instead of always halving, false position draws a straight line between the endpoints and uses where it crosses zero as the next guess.',
      metaMethod: 'False position (bracketing)',
      metaOrder: 'Linear convergence (often faster)',
      metaNeeds: 'sign change on [a, b]',
      cLabel: 'c (false position)',
      cColHeader: 'c = (a·f(b) − b·f(a)) / (f(b) − f(a))',
      aeFallbackNote: '(b − a) / 2  (bracket width — not a guaranteed bound for false position)',
      graphAria: 'Plot of f(x) with the narrowing false position bracket',
      heroGraphAria: 'Animated demo of the false position method narrowing in on a root',
      needsMsg: 'False position needs f(a)·f(b) < 0.',
      nextC: (cA, cB, fa, fb) => (cA * fb - cB * fa) / (fb - fa),
    },
  };

  /* ================================================================
     AUTO BRACKET FINDERS
     Three strategies:
     - Whole-number (default): scans consecutive integers outward from
       the origin for a sign change. preferNegative flag reverses the
       check order so negative intervals are tested before positive ones
       at each radius step.
     - Fine: scans progressively wider windows with finer steps,
       landing on a tighter (decimal) bracket close to the root.
     ================================================================ */
  function findBracketAutoWhole(fn, preferNegative) {
    const N = 1000;
    /* Scan OUTWARD from the origin at each radius i = 0, 1, 2, …
       By default positive [i, i+1] is checked before negative [-(i+1), -i].
       When preferNegative is true the order is flipped so the scanner
       returns the smallest-magnitude *negative* bracket first. */
    for (let i = 0; i < N; i++) {
      const checkPos = () => {
        const yL = fn(i), yR = fn(i + 1);
        if (isFinite(yL) && yL === 0) return [i, i + 1];
        if (isFinite(yL) && isFinite(yR) && yL * yR < 0) return [i, i + 1];
        return null;
      };
      const checkNeg = () => {
        const yNL = fn(-(i + 1)), yNR = fn(-i);
        if (isFinite(yNR) && yNR === 0) return [-(i + 1), -i];
        if (isFinite(yNL) && isFinite(yNR) && yNL * yNR < 0) return [-(i + 1), -i];
        return null;
      };

      const first  = preferNegative ? checkNeg : checkPos;
      const second = preferNegative ? checkPos : checkNeg;
      const r = first() || second();
      if (r) return r;
    }
    return null;
  }

  function findBracketAutoFine(fn, preferNegative) {
    /* When preferNegative, try a negative-biased window first */
    const windowsNeg = [
      { lo: -10,   hi: 0,    n: 400  },
      { lo: -100,  hi: 0,    n: 600  },
      { lo: -1000, hi: 0,    n: 800  },
    ];
    const windowsStd = [
      { lo: -10,   hi: 10,   n: 800  },
      { lo: -100,  hi: 100,  n: 1000 },
      { lo: -1000, hi: 1000, n: 1200 },
    ];
    const windows = preferNegative ? [...windowsNeg, ...windowsStd] : windowsStd;

    for (const { lo, hi, n } of windows) {
      const step = (hi - lo) / n;
      let prevX = lo, prevY = fn(lo);
      for (let i = 1; i <= n; i++) {
        const x = lo + i * step;
        const y = fn(x);
        if (isFinite(prevY) && prevY === 0) return [prevX, prevX + step];
        if (isFinite(prevY) && isFinite(y) && prevY * y < 0) return [prevX, x];
        prevX = x; prevY = y;
      }
    }
    return null;
  }

  /* ================================================================
     BRACKETING ALGORITHM (shared engine)
     `nextC(cA, cB, fa, fb)` supplies the method-specific formula for
     the next approximation — e.g. (a+b)/2 for bisection, or the
     false-position secant-intercept formula. Everything else
     (convergence checks, AE/RE, bracket narrowing) is identical
     across every bracketing method.

     stopMode values:
       'c-repeat'   — NEW DEFAULT: stop when c hasn't changed (floating-
                      point identical to previous c). Fast & intuitive.
       'auto'       — legacy: runs until bracket width < 4*epsilon
                      (machine precision). Can take 50+ iterations.
       'iterations' — fixed step count
       'tolerance'  — stop when AE ≤ tol
     ================================================================ */
  function runBracketingMethod(fn, a, b, mode, param, trueRoot, nextC) {
    const out  = [];
    let cA = a, cB = b;
    const maxN = (mode === 'iterations') ? Math.min(param, 200) : 200;
    const tol  = (mode === 'tolerance')  ? param : 0;
    let prevC  = NaN;   // track previous c for c-repeat check

    for (let n = 1; n <= maxN; n++) {
      const fa = fn(cA), fb = fn(cB);
      const c  = nextC(cA, cB, fa, fb);
      const fc = fn(c);

      /* AE / RE */
      let ae, re;
      if (trueRoot != null && isFinite(trueRoot)) {
        ae = Math.abs(c - trueRoot);
        re = Math.abs(trueRoot) > 1e-14 ? ae / Math.abs(trueRoot) : NaN;
      } else {
        ae = (cB - cA) / 2;                          /* max-error bound */
        re = Math.abs(c) > 1e-14 ? ae / Math.abs(c) : NaN;
      }

      const step = { n, a: cA, b: cB, fa, fb, c, fc, ae, re,
                     converged: false, reason: '' };
      out.push(step);

      /* ── Convergence checks ── */

      /* 1. f(c) = 0 exactly */
      if (Math.abs(fc) === 0) {
        step.converged = true; step.reason = 'f(c) = 0 exactly'; break;
      }

      /* 2. c-repeat: c hasn't changed from the previous iteration.
            This is the new default (mode === 'c-repeat').
            The bracket has collapsed to floating-point resolution —
            computing a new midpoint gives the same number. */
      if (mode === 'c-repeat' && n > 1 && c === prevC) {
        step.converged = true; step.reason = 'c repeated — bracket fully resolved'; break;
      }

      /* 3. Legacy machine-precision check (mode === 'auto') */
      const eps = Number.EPSILON * Math.max(1, Math.abs(cA), Math.abs(cB));
      if (mode === 'auto' && cB - cA < 4 * eps) {
        step.converged = true; step.reason = 'machine precision reached'; break;
      }

      /* 4. Fixed iteration count — just let the loop run to maxN */

      /* 5. Tolerance */
      if (mode === 'tolerance' && tol > 0 && ae <= tol) {
        step.converged = true; step.reason = `AE ≤ ${tol}`; break;
      }

      prevC = c;  // remember this c for next iteration's repeat-check

      /* Narrow the bracket.
         Guard against NaN fc (discontinuity/asymptote hit). */
      if (isNaN(fc)) {
        cA = c;
      } else if (fa * fc < 0) {
        cB = c;
      } else {
        cA = c;
      }
    }

    /* For iteration-count mode, mark the final step as "reached limit" */
    if (out.length && !out[out.length - 1].converged && mode === 'iterations') {
      out[out.length - 1].converged = true;
      out[out.length - 1].reason    = `${out.length} iterations reached`;
    }
    /* Legacy auto: mark final step if still not converged */
    if (out.length && !out[out.length - 1].converged && mode === 'auto') {
      out[out.length - 1].converged = true;
      out[out.length - 1].reason    = 'max precision reached';
    }
    /* c-repeat mode: if we exhausted maxN without repeat (unusual), note it */
    if (out.length && !out[out.length - 1].converged && mode === 'c-repeat') {
      out[out.length - 1].converged = true;
      out[out.length - 1].reason    = 'max iterations reached';
    }
    return out;
  }

  /* ================================================================
     MINI NUMBER LINE SVG
     Each table row shows the full initial range [_initA, _initB]
     as a thin baseline, with the current bracket highlighted and
     the midpoint c marked as a dot.
     ================================================================ */
  function miniLine(a, b, c) {
    const W = 148, H = 26, pad = 11;
    const rng = (_initB - _initA) || 1;
    const tx  = v => pad + ((v - _initA) / rng) * (W - 2 * pad);
    const ax = tx(a), bx = tx(b), cx = tx(c), mid = H / 2;

    return [
      `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`,
      /* full range line */
      `<line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="#253F5E" stroke-width="2"/>`,
      /* end stops */
      `<line x1="${pad}"     y1="${mid-4}" x2="${pad}"     y2="${mid+4}" stroke="#3D6694" stroke-width="1.5"/>`,
      `<line x1="${W - pad}" y1="${mid-4}" x2="${W - pad}" y2="${mid+4}" stroke="#3D6694" stroke-width="1.5"/>`,
      /* active bracket highlight */
      `<line x1="${ax}" y1="${mid}" x2="${bx}" y2="${mid}" stroke="#C9784B" stroke-width="4" stroke-linecap="round" opacity="0.65"/>`,
      /* a tick */
      `<line x1="${ax}" y1="${mid-7}" x2="${ax}" y2="${mid+7}" stroke="#7FA68C" stroke-width="2" stroke-linecap="round"/>`,
      /* b tick */
      `<line x1="${bx}" y1="${mid-7}" x2="${bx}" y2="${mid+7}" stroke="#7FA68C" stroke-width="2" stroke-linecap="round"/>`,
      /* c midpoint dot */
      `<circle cx="${cx}" cy="${mid}" r="4" fill="#E2945F" stroke="#081729" stroke-width="1.2"/>`,
      `</svg>`
    ].join('');
  }

  /* ================================================================
     RENDER: SOLUTION BOX
     Shows: equation · sign check · result
     ================================================================ */
  function renderSolBox() {
    const fa   = _fn(_initA), fb = _fn(_initB);
    const last = _steps[_steps.length - 1];
    const hasTrue = (_trueRoot != null && isFinite(_trueRoot));

    D.solBox.innerHTML = `
      <div class="sol-group">
        <div class="sol-lbl">Equation</div>
        <div class="sol-eq">f(x) = ${escHtml(D.fxInput.value.trim())}</div>
      </div>

      <div class="sol-group">
        <div class="sol-lbl">Finding the bracket — IVT sign check on [a, b]</div>
        <div class="bracket-box">
          <div class="bc-row">
            <code>f(a) = f(${fmt(_initA)}) = ${fmt(fa)}</code>
            <span class="sign-pill ${fa < 0 ? 'neg' : 'pos'}">${fa < 0 ? '− negative' : '+ positive'}</span>
          </div>
          <div class="bc-row">
            <code>f(b) = f(${fmt(_initB)}) = ${fmt(fb)}</code>
            <span class="sign-pill ${fb < 0 ? 'neg' : 'pos'}">${fb < 0 ? '− negative' : '+ positive'}</span>
          </div>
          <div class="bc-row ivt-row">
            <code>f(a) · f(b) = ${fmt(fa * fb)} &lt; 0</code>
            <span class="sign-pill ok">✓ IVT satisfied</span>
            <span class="ivt-note">→ root exists in [${fmt(_initA)}, ${fmt(_initB)}] by Intermediate Value Theorem</span>
          </div>
        </div>
      </div>

      <div class="sol-group">
        <div class="sol-lbl">Result — after ${_steps.length} iteration${_steps.length !== 1 ? 's' : ''}</div>
        <div class="result-row">
          <span class="root-chip">Root ≈ ${fmt(last.c)}</span>
          ${last.converged ? `<span class="conv-chip">✓ ${escHtml(last.reason)}</span>` : ''}
          ${hasTrue ? `<span class="ae-note">true absolute error: ${fmtE(Math.abs(last.c - _trueRoot))}</span>` : ''}
        </div>
      </div>
    `;
  }

  /* ================================================================
     RENDER: ITERATION TABLE
     ================================================================ */
  function renderTable() {
    const hasTrue = (_trueRoot != null && isFinite(_trueRoot));

    D.tHead.innerHTML = [
      'Step', 'a', 'b', 'f(a)', 'f(b)',
      METHODS[_activeMethod].cColHeader, 'f(c)', 'AE', 'RE', 'Bracket'
    ].map(h => `<th>${h}</th>`).join('');

    const last = _steps[_steps.length - 1];
    D.capSum.textContent =
      `f(x) = ${D.fxInput.value.trim()}  ·  [${fmt(_initA)}, ${fmt(_initB)}]` +
      `  ·  ${_steps.length} iteration${_steps.length !== 1 ? 's' : ''}` +
      `  ·  root ≈ ${fmt(last.c)}${last.converged ? '  ✓' : ''}`;

    D.tblNote.textContent = hasTrue
      ? `AE = |c − ${fmt(_trueRoot)}| (true root),  RE = AE / |true root|`
      : `AE = ${METHODS[_activeMethod].aeFallbackNote},  RE = AE / |c|`;

    D.tBody.innerHTML = '';
    for (const s of _steps) {
      const tr  = document.createElement('tr');
      if (s.n === _idx + 1) tr.classList.add('active-row');
      if (s.converged)      tr.classList.add('converged-row');

      const sc = v => v < 0 ? 'neg-val' : (v > 0 ? 'pos-val' : '');

      tr.innerHTML = [
        `<td>${s.n}</td>`,
        `<td>${fmt(s.a)}</td>`,
        `<td>${fmt(s.b)}</td>`,
        `<td class="${sc(s.fa)}">${fmt(s.fa)}</td>`,
        `<td class="${sc(s.fb)}">${fmt(s.fb)}</td>`,
        `<td class="c-val">${fmt(s.c)}</td>`,
        `<td class="${sc(s.fc)}">${fmt(s.fc)}</td>`,
        `<td>${fmtE(s.ae)}</td>`,
        `<td>${(s.re != null && !isNaN(s.re)) ? fmtE(s.re) : '—'}</td>`,
        `<td class="mini-cell">${miniLine(s.a, s.b, s.c)}</td>`,
      ].join('');

      D.tBody.appendChild(tr);
    }
  }

  /* ================================================================
     RENDER: MAIN GRAPH
     ================================================================ */
  function renderGraph(idx) {
    if (!_steps.length || !_fn) return;
    const s = _steps[idx];

    const W = 800, H = 456;
    const pL = 72, pR = 24, pT = 30, pB = 82;
    const pW = W - pL - pR, pH = H - pT - pB;

    /* X range: a bit wider than initial bracket */
    const rng  = _initB - _initA;
    const xMin = _initA - rng * 0.28;
    const xMax = _initB + rng * 0.28;

    /* Sample f for Y range */
    const N  = 500;
    const xs = Array.from({ length: N + 1 }, (_, i) => xMin + (xMax - xMin) * i / N);
    const ys = xs.map(x => { const v = _fn(x); return isFinite(v) ? v : null; });
    const valid = ys.filter(y => y != null);
    if (!valid.length) return;

    let yMin = Math.min(...valid), yMax = Math.max(...valid);
    const yMg = (yMax - yMin) * 0.14 || 1;
    yMin -= yMg; yMax += yMg;

    const tx = x => pL + (x - xMin) / (xMax - xMin) * pW;
    const ty = y => pT + (1 - (y - yMin) / (yMax - yMin)) * pH;

    /* Curve path */
    let path = '', pen = false;
    for (let i = 0; i <= N; i++) {
      if (ys[i] == null) { pen = false; continue; }
      const px = tx(xs[i]).toFixed(1), py = ty(ys[i]).toFixed(1);
      path += pen ? ` L${px} ${py}` : `M${px} ${py}`;
      pen = true;
    }

    const xAY = ty(0), yAX = tx(0);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`;

    /* Grid */
    for (let i = 0; i <= 8; i++) {
      const gx = (pL + i * pW / 8).toFixed(1);
      svg += `<line x1="${gx}" y1="${pT}" x2="${gx}" y2="${pT + pH}" stroke="rgba(61,102,148,.15)" stroke-width="1"/>`;
    }
    for (let i = 0; i <= 6; i++) {
      const gy = (pT + i * pH / 6).toFixed(1);
      svg += `<line x1="${pL}" y1="${gy}" x2="${pL + pW}" y2="${gy}" stroke="rgba(61,102,148,.15)" stroke-width="1"/>`;
    }

    /* Shaded bracket */
    const shX1 = Math.max(tx(s.a), pL).toFixed(1);
    const shX2 = Math.min(tx(s.b), pL + pW).toFixed(1);
    const shW  = (Math.max(0, shX2 - shX1)).toFixed(1);
    svg += `<rect x="${shX1}" y="${pT}" width="${shW}" height="${pH}" fill="rgba(201,120,75,.07)"/>`;

    /* Axes */
    if (xAY > pT && xAY < pT + pH)
      svg += `<line x1="${pL}" y1="${xAY.toFixed(1)}" x2="${pL + pW}" y2="${xAY.toFixed(1)}" stroke="#AEC0D6" stroke-width="1.5"/>`;
    if (yAX > pL && yAX < pL + pW)
      svg += `<line x1="${yAX.toFixed(1)}" y1="${pT}" x2="${yAX.toFixed(1)}" y2="${pT + pH}" stroke="#AEC0D6" stroke-width="1.5"/>`;

    /* X-axis tick labels */
    for (let i = 0; i <= 8; i++) {
      const xv = xMin + (xMax - xMin) * i / 8;
      const xp = (pL + i * pW / 8).toFixed(1);
      svg += `<text x="${xp}" y="${pT + pH + 16}" text-anchor="middle" font-size="10" fill="#7B93B0" font-family="IBM Plex Mono,monospace">${xv.toFixed(3)}</text>`;
      svg += `<line x1="${xp}" y1="${pT + pH}" x2="${xp}" y2="${pT + pH + 5}" stroke="#3D6694" stroke-width="1"/>`;
    }
    /* Y-axis tick labels */
    for (let i = 0; i <= 6; i++) {
      const yv = yMin + (yMax - yMin) * (1 - i / 6);
      const yp = (pT + i * pH / 6).toFixed(1);
      svg += `<text x="${pL - 7}" y="${+yp + 3}" text-anchor="end" font-size="10" fill="#7B93B0" font-family="IBM Plex Mono,monospace">${yv.toFixed(3)}</text>`;
      svg += `<line x1="${pL - 4}" y1="${yp}" x2="${pL}" y2="${yp}" stroke="#3D6694" stroke-width="1"/>`;
    }

    /* Axis labels */
    svg += `<text x="${(pL + pW / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" font-size="11" fill="#AEC0D6" font-family="IBM Plex Sans Condensed,sans-serif">x</text>`;
    svg += `<text x="13" y="${(pT + pH / 2).toFixed(0)}" text-anchor="middle" font-size="11" fill="#AEC0D6" font-family="IBM Plex Sans Condensed,sans-serif" transform="rotate(-90 13 ${(pT + pH / 2).toFixed(0)})">f(x)</text>`;

    /* Initial bracket ghost lines (faint, when narrowed) */
    if (s.a > _initA) {
      const x0 = tx(_initA).toFixed(1);
      svg += `<line x1="${x0}" y1="${pT}" x2="${x0}" y2="${pT + pH}" stroke="#3D6694" stroke-width="1" opacity="0.35" stroke-dasharray="3 5"/>`;
    }
    if (s.b < _initB) {
      const x0 = tx(_initB).toFixed(1);
      svg += `<line x1="${x0}" y1="${pT}" x2="${x0}" y2="${pT + pH}" stroke="#3D6694" stroke-width="1" opacity="0.35" stroke-dasharray="3 5"/>`;
    }

    /* Historical midpoint cut lines */
    if (idx > 0) {
      const span = Math.max(idx - 1, 1);
      for (let i = 0; i < idx; i++) {
        const pc  = _steps[i].c;
        const pcX = tx(pc).toFixed(1);
        const age = idx - 1 - i;
        const op  = (0.70 - 0.52 * age / span).toFixed(2);
        svg += `<line x1="${pcX}" y1="${pT}" x2="${pcX}" y2="${pT + pH}" ` +
               `stroke="#E2945F" stroke-width="1.3" stroke-dasharray="3 5" opacity="${op}"/>`;
        svg += `<circle cx="${pcX}" cy="${(pT + pH).toFixed(1)}" r="2.8" ` +
               `fill="#E2945F" opacity="${op}"/>`;
      }
    }

    /* Current bracket lines */
    const aX = tx(s.a).toFixed(1), bX = tx(s.b).toFixed(1), cX = tx(s.c).toFixed(1);
    svg += `<line x1="${aX}" y1="${pT}" x2="${aX}" y2="${pT + pH}" stroke="#7FA68C" stroke-width="1.8" stroke-dasharray="6 3"/>`;
    svg += `<line x1="${bX}" y1="${pT}" x2="${bX}" y2="${pT + pH}" stroke="#7FA68C" stroke-width="1.8" stroke-dasharray="6 3"/>`;
    svg += `<line x1="${cX}" y1="${pT}" x2="${cX}" y2="${pT + pH}" stroke="#E2945F" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.8"/>`;

    /* Function curve */
    svg += `<path d="${path}" fill="none" stroke="#7FA68C" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

    /* Points on curve + drop lines */
    const plotPt = (xv, lbl, col, r) => {
      const yv = _fn(xv);
      if (!isFinite(yv)) return '';
      const px = tx(xv).toFixed(1), py = ty(yv).toFixed(1);
      const axY = isFinite(ty(0)) ? Math.max(pT, Math.min(pT + pH, ty(0))).toFixed(1) : (pT + pH);
      return [
        `<line x1="${px}" y1="${py}" x2="${px}" y2="${axY}" stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity="0.45"/>`,
        `<circle cx="${px}" cy="${py}" r="${r}" fill="${col}" stroke="#081729" stroke-width="1.5"/>`,
        `<text x="${px}" y="${+py - r - 4}" text-anchor="middle" font-size="11" fill="${col}" font-family="IBM Plex Mono,monospace" font-weight="500">${lbl}</text>`,
      ].join('');
    };

    svg += plotPt(s.a, 'a', '#7FA68C', 5);
    svg += plotPt(s.b, 'b', '#7FA68C', 5);
    svg += plotPt(s.c, 'c', '#E2945F', 6.5);

    /* Step label overlay */
    const cutInfo = idx > 0 ? `  ·  ${idx} cut${idx === 1 ? '' : 's'}` : '';
    svg += `<rect x="${pL + 6}" y="${pT + 6}" width="320" height="20" rx="2" fill="rgba(8,23,41,.75)"/>`;
    svg += `<text x="${pL + 13}" y="${pT + 20}" font-size="11" fill="#AEC0D6" font-family="IBM Plex Mono,monospace">` +
      `Step ${s.n}  ·  a=${fmt(s.a)}  b=${fmt(s.b)}  c=${fmt(s.c)}${escHtml(cutInfo)}</text>`;

    /* Cut history lane */
    const laneT   = pT + pH + 32;
    const laneH   = 13;
    const laneBot = laneT + laneH;

    svg += `<rect x="${pL}" y="${laneT}" width="${pW}" height="${laneH}" rx="2" ` +
           `fill="#0A1F36" stroke="rgba(61,102,148,.3)" stroke-width="0.8"/>`;

    const initLX1 = Math.max(pL, Math.min(tx(_initA), pL + pW));
    const initLX2 = Math.max(pL, Math.min(tx(_initB), pL + pW));
    svg += `<rect x="${initLX1.toFixed(1)}" y="${laneT}" ` +
           `width="${Math.max(0, initLX2 - initLX1).toFixed(1)}" height="${laneH}" ` +
           `fill="rgba(61,102,148,.18)"/>`;

    svg += `<text x="${pL - 5}" y="${(laneT + laneH - 2).toFixed(1)}" text-anchor="end" ` +
           `font-size="9" fill="#7B93B0" font-family="IBM Plex Mono,monospace">cuts</text>`;

    if (idx > 0) {
      const lSpan = Math.max(idx - 1, 1);
      for (let i = 0; i < idx; i++) {
        const pcX = tx(_steps[i].c);
        if (pcX < pL || pcX > pL + pW) continue;
        const age = idx - 1 - i;
        const op  = (0.80 - 0.60 * age / lSpan).toFixed(2);
        svg += `<line x1="${pcX.toFixed(1)}" y1="${(laneT - 1).toFixed(1)}" ` +
               `x2="${pcX.toFixed(1)}" y2="${(laneBot + 1).toFixed(1)}" ` +
               `stroke="#E2945F" stroke-width="1.2" opacity="${op}"/>`;
      }
    }

    const curLX1 = Math.max(pL, Math.min(tx(s.a), pL + pW));
    const curLX2 = Math.max(pL, Math.min(tx(s.b), pL + pW));
    svg += `<rect x="${curLX1.toFixed(1)}" y="${(laneT + 1.5).toFixed(1)}" ` +
           `width="${Math.max(0, curLX2 - curLX1).toFixed(1)}" height="${(laneH - 3).toFixed(1)}" ` +
           `rx="1" fill="rgba(201,120,75,.28)" stroke="#C9784B" stroke-width="1"/>`;

    const curCLX = tx(s.c);
    if (curCLX >= pL && curCLX <= pL + pW) {
      svg += `<line x1="${curCLX.toFixed(1)}" y1="${(laneT - 4).toFixed(1)}" ` +
             `x2="${curCLX.toFixed(1)}" y2="${(laneBot + 4).toFixed(1)}" ` +
             `stroke="#E2945F" stroke-width="2.5"/>`;
      const ptx = curCLX.toFixed(1);
      svg += `<polygon points="${ptx},${(laneBot + 4).toFixed(1)} ` +
             `${(curCLX - 4).toFixed(1)},${(laneBot + 9).toFixed(1)} ` +
             `${(curCLX + 4).toFixed(1)},${(laneBot + 9).toFixed(1)}" ` +
             `fill="#E2945F" opacity="0.9"/>`;
      svg += `<text x="${ptx}" y="${(laneBot + 21).toFixed(1)}" text-anchor="middle" ` +
             `font-size="9" fill="#E2945F" font-family="IBM Plex Mono,monospace">c${s.n}</text>`;
    }

    svg += '</svg>';
    D.bisGr.innerHTML = svg;

    /* Readings */
    D.readA.textContent  = fmt(s.a);
    D.readB.textContent  = fmt(s.b);
    D.readC.textContent  = fmt(s.c);
    D.readFc.textContent = fmt(s.fc);
    if (s.converged) {
      D.readConvW.hidden = false;
      D.readConv.textContent = s.reason;
    } else {
      D.readConvW.hidden = true;
    }
    D.stepInd.textContent = `Step ${s.n} of ${_steps.length}`;
    D.prevBtn.disabled = (idx === 0);
    D.nextBtn.disabled = (idx >= _steps.length - 1);

    Array.from(D.tBody.querySelectorAll('tr')).forEach((r, i) => {
      r.classList.toggle('active-row', i === idx);
    });
  }

  /* ================================================================
     HERO ANIMATION
     ================================================================ */
  function initHero(nextC) {
    if (_heroTmr) { clearInterval(_heroTmr); _heroTmr = null; }
    nextC = nextC || ((cA, cB) => (cA + cB) / 2);
    const hFn = x => x * x * x - x - 2;
    const hSteps = [];
    let ha = 1, hb = 2;
    for (let i = 0; i < 9; i++) {
      const fa = hFn(ha), fb = hFn(hb);
      const c = nextC(ha, hb, fa, fb);
      if (!isFinite(c) || c <= Math.min(ha, hb) || c >= Math.max(ha, hb)) break;
      hSteps.push({ a: ha, b: hb, c });
      if (fa * hFn(c) < 0) hb = c; else ha = c;
    }
    if (!hSteps.length) hSteps.push({ a: ha, b: hb, c: (ha + hb) / 2 });

    const draw = idx => {
      const s  = hSteps[idx];
      D.heroLbl.textContent = `step ${idx + 1}`;

      const W = 520, H = 240;
      const pL = 34, pR = 12, pT = 16, pB = 28;
      const pW = W - pL - pR, pH = H - pT - pB;
      const yLo = -6, yHi = 6;
      const tx = x => pL + (x - 0.6) / 1.8 * pW;
      const ty = y => pT + (1 - (y - yLo) / (yHi - yLo)) * pH;

      let p = '', pen = false;
      for (let i = 0; i <= 300; i++) {
        const x = 0.6 + 1.8 * i / 300, y = hFn(x);
        if (!isFinite(y) || y < yLo - 1 || y > yHi + 1) { pen = false; continue; }
        const py = Math.max(pT, Math.min(pT + pH, ty(y))).toFixed(1);
        p += pen ? ` L${tx(x).toFixed(1)} ${py}` : `M${tx(x).toFixed(1)} ${py}`;
        pen = true;
      }

      const xAY = ty(0).toFixed(1);
      const aX = tx(s.a).toFixed(1), bX = tx(s.b).toFixed(1), cX = tx(s.c).toFixed(1);

      let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
      for (let i = 0; i <= 5; i++) {
        svg += `<line x1="${(pL + i * pW / 5).toFixed(0)}" y1="${pT}" x2="${(pL + i * pW / 5).toFixed(0)}" y2="${pT + pH}" stroke="rgba(61,102,148,.2)" stroke-width="1"/>`;
        svg += `<line x1="${pL}" y1="${(pT + i * pH / 5).toFixed(0)}" x2="${pL + pW}" y2="${(pT + i * pH / 5).toFixed(0)}" stroke="rgba(61,102,148,.2)" stroke-width="1"/>`;
      }
      svg += `<rect x="${aX}" y="${pT}" width="${(tx(s.b) - tx(s.a)).toFixed(1)}" height="${pH}" fill="rgba(201,120,75,.1)"/>`;
      svg += `<line x1="${pL}" y1="${xAY}" x2="${pL + pW}" y2="${xAY}" stroke="#AEC0D6" stroke-width="1.5"/>`;
      svg += `<line x1="${aX}" y1="${pT}" x2="${aX}" y2="${pT + pH}" stroke="#7FA68C" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      svg += `<line x1="${bX}" y1="${pT}" x2="${bX}" y2="${pT + pH}" stroke="#7FA68C" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      svg += `<line x1="${cX}" y1="${pT}" x2="${cX}" y2="${pT + pH}" stroke="#E2945F" stroke-width="1.5" stroke-dasharray="3 3" opacity=".8"/>`;
      svg += `<path d="${p}" fill="none" stroke="#7FA68C" stroke-width="2"/>`;
      const cY = hFn(s.c);
      if (isFinite(cY)) svg += `<circle cx="${cX}" cy="${ty(cY).toFixed(1)}" r="5" fill="#E2945F" stroke="#081729" stroke-width="1.5"/>`;
      [['a', aX, '#7FA68C'], ['b', bX, '#7FA68C'], ['c', cX, '#E2945F']].forEach(([l, x, col]) => {
        svg += `<text x="${x}" y="${H - 5}" text-anchor="middle" font-size="11" fill="${col}" font-family="IBM Plex Mono,monospace">${l}</text>`;
      });
      svg += '</svg>';
      D.heroGr.innerHTML = svg;
    };

    draw(0);
    let hi = 0;
    _heroTmr = setInterval(() => { hi = (hi + 1) % hSteps.length; draw(hi); }, 1650);
  }

  /* ================================================================
     SOLVE
     ================================================================ */
  function solve(e) {
    e?.preventDefault();
    clearStatus();
    if (_playTmr) { clearInterval(_playTmr); _playTmr = null; D.playBtn.textContent = '▶'; }

    /* --- f(x) --- */
    const fxRaw = D.fxInput.value.trim();
    if (!fxRaw) return showStatus('Enter a function f(x) first.');
    if (fxRaw.length > 500) return showStatus('Expression is too long — please keep it under 500 characters.');
    const fn = compileFn(fxRaw);
    if (!fn) return showStatus(`Cannot parse "${escHtml(fxRaw)}". Check your syntax — expand the tutorial below.`);

    /* --- bounds: auto-detected, or typed in manually --- */
    const _bm = document.querySelector('[name="bracketMode"]:checked')?.value ?? '';
    const bracketMode = (_bm === 'auto' || _bm === 'manual') ? _bm : 'auto';
    let a, b;

    if (bracketMode === 'manual') {
      const aRaw = D.aInput.value.trim(), bRaw = D.bInput.value.trim();
      if (!aRaw || !bRaw) return showStatus('Enter both bounds a and b (you can use e, pi, sqrt(2), etc.).');
      if (aRaw.length > 200 || bRaw.length > 200) return showStatus('Bound expression is too long (max 200 characters).');

      a = parseVal(aRaw); b = parseVal(bRaw);
      if (isNaN(a)) return showStatus(`Cannot evaluate a = "${aRaw}". Use a number or an expression like e, pi, 2*pi.`);
      if (isNaN(b)) return showStatus(`Cannot evaluate b = "${bRaw}". Use a number or an expression like e, pi, 2*pi.`);
      if (a >= b)   return showStatus('Bound a must be strictly less than b.');
      D.bracketHint.hidden = true;
    } else {
      /* Read both auto-detect option toggles */
      const wantFine    = D.fineToggle.checked;
      const wantNegPref = $('bracket-neg-toggle').checked;

      let found = wantFine
        ? findBracketAutoFine(fn, wantNegPref)
        : findBracketAutoWhole(fn, wantNegPref);

      let usedFine = wantFine;

      /* Fallback: if whole-number scan missed, try fine automatically */
      if (!found && !wantFine) {
        found = findBracketAutoFine(fn, wantNegPref);
        usedFine = true;
      }
      if (!found) return showStatus('Could not automatically find a sign change for this function within ±1000. Switch to "I\'ll set a and b myself" and enter a bracket directly — negative values like −2 are allowed.');
      [a, b] = found;
      D.aInput.value = fmt(a);
      D.bInput.value = fmt(b);
      D.bracketHint.hidden = false;
      D.bracketHint.textContent =
        (usedFine ? 'Auto-detected a tighter decimal bracket' : 'Auto-detected whole-number bracket') +
        (wantNegPref ? ' (negative priority)' : '') +
        `: a = ${fmt(a)}, b = ${fmt(b)}`;
    }

    /* --- sign check --- */
    const fa = fn(a), fb = fn(b);
    if (!isFinite(fa)) return showStatus(`f(a) = f(${fmt(a)}) is not finite. Check your function and bounds.`);
    if (!isFinite(fb)) return showStatus(`f(b) = f(${fmt(b)}) is not finite. Check your function and bounds.`);
    if (fa === 0) return showStatus(`a = ${fmt(a)} is already a root — f(a) = 0!`, 'success');
    if (fb === 0) return showStatus(`b = ${fmt(b)} is already a root — f(b) = 0!`, 'success');
    if (fa * fb > 0)
      return showStatus(`No sign change: f(${fmt(a)}) = ${fmt(fa)} and f(${fmt(b)}) = ${fmt(fb)} have the same sign. ${METHODS[_activeMethod].needsMsg}`);

    /* --- true root --- */
    const trRaw = D.trueIn.value.trim();
    _trueRoot = trRaw ? parseVal(trRaw) : null;

    /* --- stop mode --- */
    const _sm  = document.querySelector('[name="stopMode"]:checked')?.value ?? '';
    const mode = (['c-repeat','auto','iterations','tolerance'].includes(_sm)) ? _sm : 'c-repeat';
    let param  = null;
    if (mode === 'iterations') {
      param = parseInt($('iter-count').value);
      if (isNaN(param) || param < 1) return showStatus('Enter a valid iteration count (≥ 1).');
    } else if (mode === 'tolerance') {
      param = parseFloat($('tol-value').value);
      if (isNaN(param) || param <= 0) return showStatus('Enter a valid positive tolerance.');
    }

    /* --- run --- */
    _fn    = fn;
    _initA = a;
    _initB = b;
    _steps = runBracketingMethod(fn, a, b, mode, param, _trueRoot, METHODS[_activeMethod].nextC);

    if (!_steps.length) return showStatus('No steps produced — check your inputs.');

    _idx = 0;
    D.solSec.hidden = false;
    D.vizSec.hidden = false;
    D.tblSec.hidden = false;

    renderSolBox();
    renderTable();
    renderGraph(0);

    D.solSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================================================================
     PLAYBACK
     ================================================================ */
  function goTo(idx) {
    _idx = Math.max(0, Math.min(idx, _steps.length - 1));
    renderGraph(_idx);
  }

  function togglePlay() {
    if (_playTmr) {
      clearInterval(_playTmr); _playTmr = null;
      D.playBtn.textContent = '▶';
      D.playBtn.setAttribute('aria-label', 'Play');
    } else {
      if (_idx >= _steps.length - 1) _idx = -1;
      D.playBtn.textContent = '⏸';
      D.playBtn.setAttribute('aria-label', 'Pause');
      _playTmr = setInterval(() => {
        _idx++;
        if (_idx >= _steps.length) {
          clearInterval(_playTmr); _playTmr = null;
          D.playBtn.textContent = '▶';
          D.playBtn.setAttribute('aria-label', 'Play');
          return;
        }
        renderGraph(_idx);
      }, +D.speedSel.value);
    }
  }

  /* ================================================================
     RESET
     ================================================================ */
  function hideResults() {
    if (_playTmr) { clearInterval(_playTmr); _playTmr = null; D.playBtn.textContent = '▶'; }
    clearStatus();
    D.solSec.hidden = true;
    D.vizSec.hidden = true;
    D.tblSec.hidden = true;
    _steps = []; _idx = 0; _fn = null;
    D.prevBtn.disabled = true;
    D.nextBtn.disabled = true;
  }

  function reset() {
    hideResults();
    D.fxInput.value = '';
    D.aInput.value  = '';
    D.bInput.value  = '';
    D.trueIn.value  = '';
    D.fxDot.className = 'validity-dot';
    /* back to auto bracket-detection mode */
    $('bracket-mode-auto').checked = true;
    D.aInput.disabled = true;
    D.bInput.disabled = true;
    document.querySelectorAll('#bracket-mode-options .stop-option').forEach(opt => opt.classList.remove('active-mode'));
    $('bracket-mode-auto').closest('.stop-option').classList.add('active-mode');
    D.fineToggle.checked = false;
    $('bracket-neg-toggle').checked = false;
    D.bracketHint.hidden = true;
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  function buildExportEl() {
    const fx      = escHtml(D.fxInput.value.trim());
    const last    = _steps[_steps.length - 1];
    const fa      = _fn(_initA), fb = _fn(_initB);
    const hasTrue = (_trueRoot != null && isFinite(_trueRoot));
    const date    = new Date().toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });

    const thS  = 'padding:6px 9px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#7B93B0;border-bottom:2px solid rgba(61,102,148,.5);white-space:nowrap;background:#0e2140';
    const th1S = thS + ';text-align:left';
    const cols = ['Step','a','b','f(a)','f(b)', METHODS[_activeMethod].cColHeader,'f(c)','AE','RE'];
    const thead = `<thead><tr>${cols.map((h,i)=>`<th style="${i===0?th1S:thS}">${h}</th>`).join('')}</tr></thead>`;

    const tdB  = 'padding:5px 9px;border-bottom:1px solid rgba(61,102,148,.2);text-align:right;white-space:nowrap';
    const td1B = tdB + ';text-align:left';
    let rows = '';
    for (const s of _steps) {
      const rowBg = s.converged ? 'background:rgba(127,166,140,.1)' : '';
      const cFa   = s.fa < 0 ? '#D9776B' : '#7FA68C';
      const cFb   = s.fb < 0 ? '#D9776B' : '#7FA68C';
      const cFc   = s.fc < 0 ? '#D9776B' : '#7FA68C';
      const reStr = (s.re != null && !isNaN(s.re)) ? fmtE(s.re) : '\u2014';
      rows += `<tr style="${rowBg}">
        <td style="${td1B}">${s.n}</td>
        <td style="${tdB}">${fmt(s.a)}</td>
        <td style="${tdB}">${fmt(s.b)}</td>
        <td style="${tdB};color:${cFa}">${fmt(s.fa)}</td>
        <td style="${tdB};color:${cFb}">${fmt(s.fb)}</td>
        <td style="${tdB};color:#E2945F;font-weight:600">${fmt(s.c)}</td>
        <td style="${tdB};color:${cFc}">${fmt(s.fc)}</td>
        <td style="${tdB}">${fmtE(s.ae)}</td>
        <td style="${tdB}">${reStr}</td>
      </tr>`;
    }
    const tblNote = hasTrue
      ? `AE = |c \u2212 ${fmt(_trueRoot)}| (true root),  RE = AE / |true root|`
      : `AE = ${METHODS[_activeMethod].aeFallbackNote},  RE = AE / |c|`;

    const convNote = last.converged ? ` \u00b7 <span style="color:#7FA68C">\u2713 ${escHtml(last.reason)}</span>` : '';

    const inner = `
      <div style="padding:28px 36px 20px;font-family:sans-serif;color:#EDEAE0;font-size:13px;line-height:1.5">

        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid rgba(61,102,148,.45)">
          <div>
            <div style="font-size:10px;color:#7B93B0;letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px">Numerical Analysis Workbench \u00b7 ${METHODS[_activeMethod].docTitle}</div>
            <div style="font-size:20px;font-weight:700;color:#EDEAE0;font-family:monospace">f(x) = ${fx}</div>
          </div>
          <div style="font-size:11px;color:#7B93B0;text-align:right;flex-shrink:0;margin-left:24px;font-family:monospace">
            ${escHtml(date)}<br>
            <span style="color:#E2945F;font-size:17px;font-weight:700">Root \u2248 ${fmt(last.c)}</span><br>
            ${_steps.length} iteration${_steps.length!==1?'s':''}${convNote}
          </div>
        </div>

        <div style="background:#081729;border-radius:3px;padding:11px 16px;margin-bottom:14px;font-family:monospace;font-size:12px;display:flex;gap:24px;flex-wrap:wrap;align-items:center">
          <span style="color:#7B93B0;font-size:10px;text-transform:uppercase;letter-spacing:.08em">IVT Sign Check</span>
          <span>f(a) = f(${fmt(_initA)}) = <span style="color:${fa<0?'#D9776B':'#7FA68C'}">${fmt(fa)}</span></span>
          <span>f(b) = f(${fmt(_initB)}) = <span style="color:${fb<0?'#D9776B':'#7FA68C'}">${fmt(fb)}</span></span>
          <span style="color:#7FA68C">\u2713 f(a)\u00b7f(b) &lt; 0 \u2014 IVT satisfied \u2192 root in [${fmt(_initA)}, ${fmt(_initB)}]</span>
        </div>

        <table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:12px">
          ${thead}<tbody>${rows}</tbody>
        </table>
        <div style="font-size:10px;color:#7B93B0;margin-top:7px;font-family:monospace">${escHtml(tblNote)}</div>

        <div style="font-size:10px;color:#7B93B0;padding-top:10px;margin-top:10px;border-top:1px dashed rgba(61,102,148,.4);display:flex;justify-content:space-between;font-family:monospace">
          <span>S.M. Mehedy Kawser \u00b7 mehedy.netlify.app</span>
          <span>Generated ${escHtml(date)}</span>
        </div>
      </div>`;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;top:0;left:0;width:1120px;background:#173A60;z-index:99998;overflow:visible;pointer-events:none';
    wrap.innerHTML = inner;
    document.body.appendChild(wrap);
    return wrap;
  }

  async function exportImage() {
    if (!_steps.length) return;
    const btn = D.expImg;
    btn.textContent = 'Capturing\u2026'; btn.disabled = true;
    const overlay  = mkCaptureOverlay('Preparing Image\u2026');
    const exportEl = buildExportEl();
    await waitFrames();
    try {
      const canvas = await html2canvas(exportEl, {
        backgroundColor: '#173A60',
        scale: 2,
        logging: false,
        useCORS: true,
        allowTaint: true,
        width: 1120,
        height: exportEl.scrollHeight,
        windowWidth: 1200,
        scrollX: 0,
        scrollY: 0
      });
      dl(await canvasBlob(canvas), `${_activeMethod}_${ts()}.png`);
    } catch (err) { alert('Image export failed: ' + err.message); }
    finally {
      exportEl.remove();
      overlay.remove();
      btn.textContent = 'Download as image';
      btn.disabled = false;
    }
  }

  async function exportPDF() {
    if (!_steps.length) return;
    const btn = D.expPdf;
    btn.textContent = 'Generating\u2026'; btn.disabled = true;
    const overlay  = mkCaptureOverlay('Preparing PDF\u2026');
    const exportEl = buildExportEl();
    await waitFrames();
    try {
      const canvas  = await html2canvas(exportEl, {
        backgroundColor: '#173A60',
        scale: 2,
        logging: false,
        useCORS: true,
        allowTaint: true,
        width: 1120,
        height: exportEl.scrollHeight,
        windowWidth: 1200,
        scrollX: 0,
        scrollY: 0
      });
      const { jsPDF } = window.jspdf;
      const pdf     = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pgW     = pdf.internal.pageSize.getWidth();
      const pgH     = pdf.internal.pageSize.getHeight();
      const imgData = canvas.toDataURL('image/png');
      const imgH    = (canvas.height / canvas.width) * pgW;
      if (imgH <= pgH) {
        pdf.addImage(imgData, 'PNG', 0, 0, pgW, imgH);
      } else {
        let yOff = 0;
        while (yOff < imgH) {
          if (yOff > 0) pdf.addPage();
          pdf.addImage(imgData, 'PNG', 0, -yOff, pgW, imgH);
          yOff += pgH;
        }
      }
      pdf.save(`${_activeMethod}_${ts()}.pdf`);
    } catch (err) { alert('PDF export failed: ' + err.message); }
    finally {
      exportEl.remove();
      overlay.remove();
      btn.textContent = 'Download as PDF';
      btn.disabled = false;
    }
  }

  /* ================================================================
     EVENT LISTENERS
     ================================================================ */
  document.querySelectorAll('input[name="bracketMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const manual = radio.value === 'manual';
      D.aInput.disabled = !manual;
      D.bInput.disabled = !manual;
      if (manual) {
        D.aInput.placeholder = 'e.g. 1 or pi/2';
        D.bInput.placeholder = 'e.g. 2 or e';
        D.bracketHint.hidden = true;
      } else {
        D.aInput.placeholder = 'auto-detected on Solve';
        D.bInput.placeholder = 'auto-detected on Solve';
        D.aInput.value = '';
        D.bInput.value = '';
      }
    });
  });

  D.precisionIn.addEventListener('input', () => {
    let v = parseInt(D.precisionIn.value, 10);
    if (isNaN(v)) return;
    v = Math.min(8, Math.max(1, v));
    NAW.setPrecision(v);
    if (_steps.length) {
      renderSolBox();
      renderTable();
      renderGraph(_idx);
    }
  });
  D.precisionIn.addEventListener('blur', () => { D.precisionIn.value = NAW.getPrecision(); });

  $('bisection-form').addEventListener('submit', solve);
  $('reset-btn').addEventListener('click', reset);

  D.prevBtn.addEventListener('click', () => goTo(_idx - 1));
  D.nextBtn.addEventListener('click', () => goTo(_idx + 1));
  D.playBtn.addEventListener('click', togglePlay);
  D.speedSel.addEventListener('change', () => {
    if (_playTmr) { togglePlay(); togglePlay(); }
  });

  D.expImg.addEventListener('click',  exportImage);
  D.expPdf.addEventListener('click',  exportPDF);

  $('load-example').addEventListener('click', () => {
    const ex = EXAMPLES[_exIdx++ % EXAMPLES.length];
    D.fxInput.value = ex.fx;
    $('bracket-mode-manual').checked = true;
    $('bracket-mode-manual').dispatchEvent(new Event('change'));
    D.aInput.value  = ex.a;
    D.bInput.value  = ex.b;
    D.fxDot.className = 'validity-dot ok';
    clearStatus();
    showStatus(`Example loaded: ${ex.note}`, 'success');
  });

  /* Live f(x) validation */
  let _fxTimer;
  D.fxInput.addEventListener('input', () => {
    clearTimeout(_fxTimer);
    _fxTimer = setTimeout(() => {
      const v = D.fxInput.value.trim();
      if (!v) { D.fxDot.className = 'validity-dot'; return; }
      const fn = compileFn(v);
      if (!fn) { D.fxDot.className = 'validity-dot bad'; return; }
      const t = fn(1);
      D.fxDot.className = isFinite(t) ? 'validity-dot ok' : 'validity-dot bad';
    }, 280);
  });

  /* ================================================================
     METHOD SWITCHING
     ================================================================ */
  function applyMethodContent(m) {
    document.title = `Numerical Analysis Workbench — ${m.docTitle}`;
    D.heroTitle.innerHTML  = m.heroTitleHTML;
    D.heroSubEl.textContent = m.heroSub;
    D.metaMethodVal.textContent = m.metaMethod;
    D.metaOrderVal.textContent  = m.metaOrder;
    D.metaNeedsVal.textContent  = m.metaNeeds;
    D.cReadingLabel.textContent = m.cLabel;
    D.bisGr.setAttribute('aria-label', m.graphAria);
    D.heroGr.setAttribute('aria-label', m.heroGraphAria);
    document.querySelectorAll('.plate-tag').forEach(el => {
      el.textContent = el.textContent.replace(/Sheet \d+/, 'Sheet ' + m.num);
    });
    initHero(m.nextC);
  }

  function setMethod(id) {
    const m = METHODS[id];
    if (!m || id === _activeMethod) return;

    document.querySelectorAll('.sheet-item[data-method]').forEach(el => {
      el.classList.toggle('active', el.dataset.method === id);
    });
    document.querySelectorAll('.mobile-nav button[data-method]').forEach(el => {
      el.classList.toggle('active', el.dataset.method === id);
    });

    hideResults();
    _activeMethod = id;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { applyMethodContent(m); return; }

    D.heroSection.classList.add('is-swapping');
    setTimeout(() => {
      applyMethodContent(m);
      D.heroSection.classList.remove('is-swapping');
    }, 220);
  }

  function wireMethodSwitch(el) {
    if (!el || el.classList.contains('disabled') || el.disabled) return;
    const id = el.dataset.method;
    if (!id) return;
    el.addEventListener('click', () => setMethod(id));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMethod(id); }
    });
  }
  document.querySelectorAll('.sheet-item[data-method]').forEach(wireMethodSwitch);
  document.querySelectorAll('.mobile-nav button[data-method]').forEach(wireMethodSwitch);

  /* ================================================================
     INIT
     ================================================================ */
  initHero(METHODS[_activeMethod].nextC);

})();
