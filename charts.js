/**
 * Time-series charts on <canvas>, for the system detail views and large
 * screens: dozens of curves redrawn every second would be costly in SVG.
 * Exposed as window.charts.
 */
(function (root) {
  /** Canvas sized to its CSS box at the screen's pixel density. */
  function prepare(canvas) {
    const dpr = root.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  /** Round maximum for an axis: 1, 2 or 5 times a power of ten. */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function maxOf(series) {
    let m = -Infinity;
    for (const s of series) for (const v of s.values) if (v > m) m = v;
    return m;
  }

  /**
   * Draws `opts.series` ([{ values, color, fill }]) against `opts.t` (ms).
   *   max      fixed maximum (100 for loads), or auto from the data (with `floor`)
   *   min      bottom of the axis (0 by default)
   *   fmtY     axis value label; no axis labels when absent
   *   fmtT     time label; no time axis when absent
   *   font     CSS font of the labels; colors: { grid, text }
   *   hover    index to highlight with a vertical line
   * Returns the geometry, to map a pointer position to an index (indexAt).
   */
  function draw(canvas, opts) {
    const c = prepare(canvas);
    if (!c) return null;
    const { ctx, w, h } = c;
    const { t, series, fmtY, fmtT, colors = {}, font = '12px sans-serif' } = opts;
    const fontPx = parseFloat(font) || 12;
    const n = t.length;
    const min = opts.min ?? 0;
    const max = opts.max ?? niceMax(Math.max(maxOf(series), opts.floor ?? 0));
    ctx.font = font;
    // Room for the widest axis label on the right, and for half a label above
    // the top line and below the bottom one.
    const labelW = fmtY ? Math.max(...[min, (min + max) / 2, max].map((v) => ctx.measureText(fmtY(v)).width)) : 0;
    const pad = {
      l: 2,
      r: fmtY ? Math.ceil(labelW + fontPx * 0.5) : 2,
      t: fmtY ? Math.ceil(fontPx * 0.6) : 2,
      b: fmtT ? Math.ceil(fontPx * 1.6) : fmtY ? Math.ceil(fontPx * 0.6) : 2,
    };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const x = (i) => pad.l + (n > 1 ? (i / (n - 1)) * pw : pw);
    const y = (v) => pad.t + ph - ((Math.min(Math.max(v, min), max) - min) / (max - min || 1)) * ph;

    if (fmtY) {
      ctx.strokeStyle = colors.grid;
      ctx.fillStyle = colors.text;
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      for (const f of [0, 0.5, 1]) {
        const yy = Math.round(pad.t + ph - f * ph) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, yy);
        ctx.lineTo(pad.l + pw, yy);
        ctx.stroke();
        ctx.fillText(fmtY(min + (max - min) * f), pad.l + pw + fontPx * 0.4, yy);
      }
    }
    if (fmtT && n > 1) {
      ctx.fillStyle = colors.text;
      ctx.textBaseline = 'top';
      for (const [f, align] of [[0, 'left'], [0.5, 'center'], [1, 'right']]) {
        ctx.textAlign = align;
        ctx.fillText(fmtT(t[Math.round(f * (n - 1))]), x(Math.round(f * (n - 1))), pad.t + ph + fontPx * 0.3);
      }
      ctx.textAlign = 'left';
    }

    for (const s of series) {
      // Gaps (NaN) split the curve instead of dropping it to zero.
      const runs = [];
      let run = [];
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(s.values[i])) run.push(i);
        else if (run.length) { runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
      for (const r of runs) {
        ctx.beginPath();
        r.forEach((i, k) => (k ? ctx.lineTo(x(i), y(s.values[i])) : ctx.moveTo(x(i), y(s.values[i]))));
        if (s.fill) {
          ctx.save();
          ctx.lineTo(x(r[r.length - 1]), pad.t + ph);
          ctx.lineTo(x(r[0]), pad.t + ph);
          ctx.closePath();
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = s.color;
          ctx.fill();
          ctx.restore();
          ctx.beginPath();
          r.forEach((i, k) => (k ? ctx.lineTo(x(i), y(s.values[i])) : ctx.moveTo(x(i), y(s.values[i]))));
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width ?? 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    if (opts.hover != null && n > 1) {
      const xx = Math.round(x(opts.hover)) + 0.5;
      ctx.strokeStyle = colors.text;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(xx, pad.t);
      ctx.lineTo(xx, pad.t + ph);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return { pad, pw, n, max };
  }

  /** Index of the point under a pointer at `clientX`, or null. */
  function indexAt(canvas, geom, clientX) {
    if (!geom || geom.n < 2) return null;
    const rect = canvas.getBoundingClientRect();
    const f = (clientX - rect.left - geom.pad.l) / geom.pw;
    if (f < 0 || f > 1) return null;
    return Math.round(f * (geom.n - 1));
  }

  root.charts = { draw, indexAt, niceMax };
})(typeof self !== 'undefined' ? self : this);
