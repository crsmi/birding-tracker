/* ==========================================================================
   calendar-view.js — Calendars module rendering layer
   Renders a CalendarResult (see calendar-core.js) as a 12 x 31 heatmap
   matrix (months as rows, day-of-month as columns), with legend, hover
   tooltip, click-to-pin details panel and an offscreen-canvas PNG export.
   Plain browser JS (no build, no libraries). Attaches window.CalendarView.
   ========================================================================== */
(function (global) {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = 31;

  // Sequential perceptual palette (viridis, low end trimmed so the lowest
  // non-zero values remain visible against the dark UI background).
  var PALETTE = [
    [72, 40, 120],   // #482878
    [62, 73, 137],   // #3e4989
    [49, 104, 142],  // #31688e
    [38, 130, 142],  // #26828e
    [31, 158, 137],  // #1f9e89
    [53, 183, 121],  // #35b779
    [110, 206, 88],  // #6ece58
    [181, 222, 43],  // #b5de2b
    [253, 231, 37]   // #fde725
  ];

  // Colors used by the PNG export (matches app.js map export tone).
  var PNG = {
    bg: '#0f1729',
    brand: '#38bdf8',
    title: '#ffffff',
    muted: '#94a3b8',
    faint: '#64748b',
    zeroBg: '#1c2433',
    zeroText: '#64748b',
    invalidBg: '#121a2b',
    invalidLine: 'rgba(255, 255, 255, 0.06)',
    border: 'rgba(255, 255, 255, 0.08)',
    summaryBg: '#162033',
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif'
  };

  /* ------------------------------------------------------------------------
     Color helpers
     ------------------------------------------------------------------------ */

  function clamp01(t) {
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  function paletteRGB(t) {
    t = clamp01(t);
    var scaled = t * (PALETTE.length - 1);
    var i = Math.floor(scaled);
    if (i >= PALETTE.length - 1) return PALETTE[PALETTE.length - 1].slice();
    var f = scaled - i;
    var a = PALETTE[i];
    var b = PALETTE[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    ];
  }

  function normalize(value, min, max) {
    if (!isFinite(min) || !isFinite(max) || max <= min) return 1; // min===max -> top color
    return clamp01((value - min) / (max - min));
  }

  function rgbFor(value, min, max) {
    return paletteRGB(normalize(value, min, max));
  }

  function rgbString(rgb) {
    return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
  }

  /** Public: css color for a value on the min..max scale. */
  function colorFor(value, min, max) {
    return rgbString(rgbFor(value, min, max));
  }

  function relativeLuminance(rgb) {
    var c = rgb.map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /** Dark or light text, whichever has the higher WCAG contrast ratio. */
  function textColorFor(rgb) {
    var L = relativeLuminance(rgb);
    var contrastWhite = 1.05 / (L + 0.05);
    var contrastBlack = (L + 0.05) / 0.05;
    return contrastBlack >= contrastWhite ? '#0b1020' : '#ffffff';
  }

  function gradientCSS() {
    var stops = [];
    for (var i = 0; i <= 10; i++) {
      stops.push(rgbString(paletteRGB(i / 10)) + ' ' + (i * 10) + '%');
    }
    return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  }

  /* ------------------------------------------------------------------------
     Formatting helpers
     ------------------------------------------------------------------------ */

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    var v = Number(n) || 0;
    return v.toLocaleString();
  }

  function fmtMonthDay(month, day) {
    return MONTHS[month - 1] + ' ' + day;
  }

  function fmtFullDate(dateStr) {
    var p = String(dateStr || '').split('-');
    if (p.length !== 3) return String(dateStr || '');
    var m = parseInt(p[1], 10);
    var d = parseInt(p[2], 10);
    if (!(m >= 1 && m <= 12)) return String(dateStr);
    return MONTHS[m - 1] + ' ' + d + ', ' + p[0];
  }

  function plural(n, one, many) {
    return n === 1 ? one : (many || one + 's');
  }

  function isNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* ------------------------------------------------------------------------
     Details content (shared by tooltip + pinned details panel)
     ------------------------------------------------------------------------ */

  function yearsChips(years, limit) {
    var list = years.slice();
    var extra = 0;
    if (limit && list.length > limit) {
      extra = list.length - limit;
      list = list.slice(list.length - limit); // most recent years
    }
    var html = list.map(function (y) {
      return '<span class="cal-chip">' + escapeHTML(y) + '</span>';
    }).join('');
    if (extra) html = '<span class="cal-chip cal-chip--more">+' + extra + ' earlier</span>' + html;
    return '<div class="cal-chips">' + html + '</div>';
  }

  /**
   * Build the inner HTML describing a cell.
   * @param {boolean} full — true for the pinned panel (no truncation).
   */
  function detailsHTML(result, cell, full) {
    var view = result.view;
    var d = cell.details || {};
    var value = isNumber(cell.value) ? cell.value : 0;
    var yearLimit = full ? 0 : 12;
    var html = '';

    html += '<div class="cal-info__head">' +
      '<span class="cal-info__date">' + escapeHTML(fmtMonthDay(cell.month, cell.day)) + '</span>' +
      '<span class="cal-info__value"><strong>' + fmtNum(value) + '</strong> ' +
      escapeHTML(result.valueLabel || '') + '</span>' +
      '</div>';

    var body = '';
    if (view === 'species') {
      var sYears = Array.isArray(d.years) ? d.years : [];
      body += '<div class="cal-info__row"><span class="cal-info__k">Checklists</span><span class="cal-info__v">' +
        fmtNum(d.checklists || 0) + '</span></div>';
      if (sYears.length) {
        body += '<div class="cal-info__label">Years with sightings (' + sYears.length + ')</div>' +
          yearsChips(sYears, yearLimit);
      }
    } else if (view === 'checklists') {
      var yMap = d.years && typeof d.years === 'object' ? d.years : {};
      var yKeys = Object.keys(yMap).sort();
      if (yKeys.length) {
        body += '<div class="cal-info__label">Checklists by year (' + yKeys.length + ' ' +
          plural(yKeys.length, 'year') + ')</div>';
        var shown = yKeys;
        var hidden = 0;
        if (!full && yKeys.length > 10) {
          hidden = yKeys.length - 10;
          shown = yKeys.slice(yKeys.length - 10);
        }
        body += '<div class="cal-info__years">';
        if (hidden) body += '<span class="cal-info__yr cal-info__yr--more">+' + hidden + ' earlier</span>';
        shown.forEach(function (y) {
          body += '<span class="cal-info__yr"><span>' + escapeHTML(y) + '</span><strong>' +
            fmtNum(yMap[y]) + '</strong></span>';
        });
        body += '</div>';
      }
    } else if (view === 'single') {
      var gYears = Array.isArray(d.years) ? d.years : [];
      if (gYears.length) {
        body += '<div class="cal-info__label">Years recorded (' + gYears.length + ')</div>' +
          yearsChips(gYears, yearLimit);
      } else {
        body += '<div class="cal-info__muted">Never recorded on this date.</div>';
      }
    } else if (view === 'bigday') {
      var recs = Array.isArray(d.records) ? d.records : [];
      if (recs.length) {
        var shownRecs = full ? recs : recs.slice(0, 4);
        body += '<div class="cal-info__label">' + (recs.length > 1 ? 'Tied record days (' + recs.length + ')' : 'Record day') + '</div>';
        shownRecs.forEach(function (r) {
          var locs = Array.isArray(r.locations) ? r.locations : [];
          var locShown = full ? locs : locs.slice(0, 3);
          body += '<div class="cal-rec">' +
            '<div class="cal-rec__head"><span>' + escapeHTML(fmtFullDate(r.date)) + '</span>' +
            '<strong>' + fmtNum(r.count) + ' ' + escapeHTML(plural(Number(r.count), 'species', 'species')) + '</strong></div>';
          if (locShown.length) {
            body += '<ul class="cal-rec__locs">' + locShown.map(function (l) {
              return '<li>' + escapeHTML(l) + '</li>';
            }).join('') + (locs.length > locShown.length ? '<li class="cal-info__muted">+' +
              (locs.length - locShown.length) + ' more ' + plural(locs.length - locShown.length, 'location') + '</li>' : '') +
              '</ul>';
          }
          body += '</div>';
        });
        if (recs.length > shownRecs.length) {
          body += '<div class="cal-info__muted">+' + (recs.length - shownRecs.length) + ' more tied days — click to see all</div>';
        }
      } else {
        body += '<div class="cal-info__muted">No checklists on this date.</div>';
      }
    }

    if (body) html += '<div class="cal-info__body">' + body + '</div>';
    if (!full) html += '<div class="cal-info__hint">Click to pin details</div>';
    return html;
  }

  /* ------------------------------------------------------------------------
     Shared floating tooltip (one element for the whole page)
     ------------------------------------------------------------------------ */

  var tooltipEl = null;

  function getTooltip() {
    if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'cal-tooltip';
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function positionTooltip(tip, x, y) {
    var pad = 14;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var left = x + pad;
    var top = y + pad;
    if (left + w + 8 > vw) left = Math.max(8, x - w - pad);
    if (top + h + 8 > vh) top = Math.max(8, y - h - pad);
    tip.style.transform = 'translate(' + Math.round(left) + 'px, ' + Math.round(top) + 'px)';
  }

  /* ------------------------------------------------------------------------
     renderMatrix
     ------------------------------------------------------------------------ */

  function cellAt(result, m, d) {
    var row = result.cells && result.cells[m];
    return row ? row[d] : null;
  }

  function isWeekEndDay(day1Based) {
    return day1Based === 7 || day1Based === 14 || day1Based === 21;
  }

  function buildWrapHeaderHTML(summaryLabel) {
    var p = ['<div class="cal-wrap-head" aria-hidden="true"><div class="cal-wrap-head__spacer">Day</div><div class="cal-wrap-head__rows">'];
    p.push('<div class="cal-wrap-head__row">');
    for (var d1 = 1; d1 <= 16; d1++) {
      p.push('<span class="cal-wrap-head__d' + (isWeekEndDay(d1) ? ' is-week-end' : '') + '">' + d1 + '</span>');
    }
    p.push('</div><div class="cal-wrap-head__row">');
    for (var d2 = 17; d2 <= 31; d2++) {
      p.push('<span class="cal-wrap-head__d' + (isWeekEndDay(d2) ? ' is-week-end' : '') + '">' + d2 + '</span>');
    }
    p.push('<span class="cal-wrap-head__d cal-wrap-head__sum" title="' + escapeHTML(summaryLabel || '') + '">Σ</span>');
    p.push('</div></div></div>');
    return p.join('');
  }

  function buildTableHTML(result) {
    var view = result.view;
    var min = Number(result.min) || 0;
    var max = Number(result.max) || 0;
    var summaries = Array.isArray(result.rowSummaries) ? result.rowSummaries : [];
    var parts = [];

    parts.push(buildWrapHeaderHTML(result.summaryLabel));
    parts.push('<table class="cal-grid cal-grid--' + escapeHTML(view) + '">');
    parts.push('<caption id="cal-table-caption" class="cal-sr-only">' + escapeHTML(result.valueLabel || '') + ' by month and day</caption>');
    parts.push('<thead><tr><th class="cal-grid__corner" scope="col"><span class="cal-sr-only">Month</span></th>');
    for (var d = 1; d <= DAYS; d++) {
      var wCls = isWeekEndDay(d) ? ' is-week-end' : '';
      parts.push('<th class="cal-grid__day' + wCls + '" scope="col">' + d + '</th>');
    }
    parts.push('<th class="cal-grid__sumhead" scope="col" title="' + escapeHTML(result.summaryLabel || '') + '">Month</th></tr></thead><tbody>');

    for (var m = 0; m < 12; m++) {
      var s = summaries[m];
      var sText = isNumber(s) ? fmtNum(s) : '–';
      parts.push('<tr><th class="cal-grid__month" scope="row"><span class="cal-grid__month-name">' + MONTHS[m] +
        '</span><span class="cal-grid__month-sum" title="' + escapeHTML(result.summaryLabel || '') + '">' + sText + '</span></th>');
      for (var di = 0; di < DAYS; di++) {
        var dayNum = di + 1;
        var wk = isWeekEndDay(dayNum) ? ' is-week-end' : '';
        var cell = cellAt(result, m, di);
        if (!cell) {
          parts.push('<td class="cal-cell is-invalid' + wk + '" aria-hidden="true"></td>');
          continue;
        }
        var v = isNumber(cell.value) ? cell.value : 0;
        var attrs = ' data-m="' + m + '" data-d="' + di + '" data-day="' + dayNum + '"';
        var label = MONTHS[m] + ' ' + dayNum + ': ' + v + ' ' + (result.valueLabel || '');
        if (v > 0) {
          var rgb = rgbFor(v, min, max);
          parts.push('<td class="cal-cell is-value' + wk + '"' + attrs + ' tabindex="0" role="button" style="background:' + rgbString(rgb) +
            ';color:' + textColorFor(rgb) + '" aria-label="' + escapeHTML(label) + '">' + v + '</td>');
        } else if (view === 'single') {
          parts.push('<td class="cal-cell is-zero is-blank' + wk + '"' + attrs + ' tabindex="0" role="button" aria-label="' + escapeHTML(label) + '"></td>');
        } else {
          parts.push('<td class="cal-cell is-zero' + wk + '"' + attrs + ' tabindex="0" role="button" aria-label="' + escapeHTML(label) + '">0</td>');
        }
      }
      parts.push('<td class="cal-grid__sum">' + sText + '</td></tr>');
    }
    parts.push('</tbody></table>');
    return parts.join('');
  }

  function buildLegendHTML(result) {
    var min = Number(result.min) || 0;
    var max = Number(result.max) || 0;
    var hasValues = max > 0;
    var html = '<div class="cal-legend">';
    html += '<span class="cal-legend__title">' + escapeHTML(result.valueLabel || '') + '</span>';
    if (hasValues) {
      if (max > min) {
        html += '<span class="cal-legend__label">' + fmtNum(min) + '</span>' +
          '<span class="cal-legend__bar" style="background:' + gradientCSS() + '"></span>' +
          '<span class="cal-legend__label">' + fmtNum(max) + '</span>';
      } else {
        html += '<span class="cal-legend__swatch" style="background:' + colorFor(max, min, max) + '"></span>' +
          '<span class="cal-legend__label">' + fmtNum(max) + '</span>';
      }
    }
    if (result.view !== 'single') {
      html += '<span class="cal-legend__key"><span class="cal-legend__swatch cal-legend__swatch--zero">0</span>none</span>';
    } else {
      html += '<span class="cal-legend__key"><span class="cal-legend__swatch cal-legend__swatch--blank"></span>not recorded</span>';
    }
    html += '<span class="cal-legend__key"><span class="cal-legend__swatch cal-legend__swatch--invalid"></span>no such date</span>';
    html += '</div>';
    return html;
  }

  function renderMatrix(containerEl, result, opts) {
    if (!containerEl) return;
    opts = opts || {};
    var tip = getTooltip();
    tip.hidden = true;

    if (!result || !result.totals || !result.totals.observations) {
      containerEl.innerHTML = '<div class="cal-empty">' +
        escapeHTML(opts.emptyMessage || 'No observations match the current filters.') + '</div>';
      return;
    }

    var mode = opts.layoutMode || 'scroll';
    containerEl.innerHTML =
      '<div class="cal-view cal-view--' + escapeHTML(mode) + '" data-layout-mode="' + escapeHTML(mode) + '">' +
        '<div class="cal-scroll" tabindex="0" role="region" aria-labelledby="cal-table-caption">' + buildTableHTML(result) + '</div>' +
        buildLegendHTML(result) +
        '<div class="cal-details" hidden aria-live="polite">' +
          '<button type="button" class="cal-details__close" aria-label="Close details">×</button>' +
          '<div class="cal-details__content cal-info"></div>' +
        '</div>' +
      '</div>';

    var table = containerEl.querySelector('.cal-grid');
    var details = containerEl.querySelector('.cal-details');
    var detailsContent = details.querySelector('.cal-details__content');
    var closeBtn = details.querySelector('.cal-details__close');
    var hoverTd = null;
    var pinnedTd = null;
    var rafId = 0;
    var lastX = 0;
    var lastY = 0;

    function cellFromTd(td) {
      if (!td || !td.hasAttribute('data-m')) return null;
      return cellAt(result, +td.getAttribute('data-m'), +td.getAttribute('data-d'));
    }

    function hideTip() {
      hoverTd = null;
      tip.hidden = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    function schedulePosition() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        if (!tip.hidden) positionTooltip(tip, lastX, lastY);
      });
    }

    function unpin() {
      if (pinnedTd) pinnedTd.classList.remove('is-selected');
      pinnedTd = null;
      details.hidden = true;
    }

    function pin(td) {
      var cell = cellFromTd(td);
      if (!cell) return;
      if (pinnedTd === td) { unpin(); return; }
      if (pinnedTd) pinnedTd.classList.remove('is-selected');
      pinnedTd = td;
      td.classList.add('is-selected');
      detailsContent.innerHTML = detailsHTML(result, cell, true);
      details.hidden = false;
    }

    table.addEventListener('mouseover', function (e) {
      var td = e.target.closest ? e.target.closest('td.cal-cell') : null;
      if (td === hoverTd) return;
      var cell = cellFromTd(td);
      if (!cell) { hideTip(); return; }
      hoverTd = td;
      tip.innerHTML = '<div class="cal-info">' + detailsHTML(result, cell, false) + '</div>';
      tip.hidden = false;
      lastX = e.clientX; lastY = e.clientY;
      positionTooltip(tip, lastX, lastY);
    });

    table.addEventListener('mousemove', function (e) {
      if (!hoverTd) return;
      lastX = e.clientX; lastY = e.clientY;
      schedulePosition();
    });

    table.addEventListener('mouseleave', hideTip);
    containerEl.querySelector('.cal-scroll').addEventListener('scroll', hideTip, { passive: true });

    table.addEventListener('click', function (e) {
      var td = e.target.closest ? e.target.closest('td.cal-cell') : null;
      if (!td) return;
      hideTip();
      pin(td);
    });

    table.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var td = e.target.closest ? e.target.closest('td.cal-cell') : null;
      if (!td || !td.hasAttribute('data-m')) return;
      e.preventDefault();
      hideTip();
      pin(td);
    });

    closeBtn.addEventListener('click', unpin);
    activeEscape = function () {
      if (!containerEl.isConnected) { activeEscape = null; return; }
      hideTip();
      unpin();
    };
    ensureEscapeListener();
  }

  // One document-level Escape handler shared by all renders (no per-render leak).
  var activeEscape = null;
  var escapeListenerInstalled = false;
  function ensureEscapeListener() {
    if (escapeListenerInstalled) return;
    escapeListenerInstalled = true;
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && activeEscape) activeEscape();
    });
  }

  /* ------------------------------------------------------------------------
     exportPNG — draws the matrix on an offscreen canvas and downloads it
     ------------------------------------------------------------------------ */

  function fitFont(ctx, text, weight, size, maxWidth) {
    var s = size;
    ctx.font = weight + ' ' + s + 'px ' + PNG.font;
    while (s > 7 && ctx.measureText(text).width > maxWidth) {
      s -= 1;
      ctx.font = weight + ' ' + s + 'px ' + PNG.font;
    }
    return s;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function sanitizeFilename(name) {
    var base = String(name || 'birding-tracker-calendar.png').replace(/[\\/:*?"<>|]+/g, '-');
    if (!/\.png$/i.test(base)) base += '.png';
    return base;
  }

  function downloadCanvas(canvas, filename) {
    return new Promise(function (resolve) {
      function viaHref(href, revoke) {
        var link = document.createElement('a');
        link.download = filename;
        link.href = href;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
        resolve(true);
      }
      try {
        if (canvas.toBlob) {
          canvas.toBlob(function (blob) {
            if (blob) viaHref(URL.createObjectURL(blob), true);
            else viaHref(canvas.toDataURL('image/png'), false);
          }, 'image/png');
        } else {
          viaHref(canvas.toDataURL('image/png'), false);
        }
      } catch (err) {
        console.warn('Calendar PNG export failed:', err);
        resolve(false);
      }
    });
  }

  function exportPNG(result, options) {
    options = options || {};
    if (!result || !result.cells) return Promise.resolve(false);

    var view = result.view;
    var min = Number(result.min) || 0;
    var max = Number(result.max) || 0;
    var summaries = Array.isArray(result.rowSummaries) ? result.rowSummaries : [];
    var title = options.title || 'Birding Calendar';
    var subtitle = options.subtitle || '';

    // Layout (CSS pixels; canvas scaled by DPR)
    var DPR = 2;
    var PAD = 40;
    var CELL = 34;
    var GAP = 2;
    var LABEL_W = 52;
    var SUM_GAP = 10;
    var SUM_W = 56;
    var HEAD_H = 26;
    var gridW = DAYS * CELL;
    var width = PAD + LABEL_W + gridW + SUM_GAP + SUM_W + PAD;
    var titleTop = PAD;
    var gridTop = titleTop + 18 + 40 + (subtitle ? 26 : 0) + 22;
    var rowsTop = gridTop + HEAD_H;
    var legendTop = rowsTop + 12 * CELL + 28;
    var height = legendTop + 40 + PAD;

    var canvas = document.createElement('canvas');
    canvas.width = width * DPR;
    canvas.height = height * DPR;
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(false);
    ctx.scale(DPR, DPR);

    // Background
    ctx.fillStyle = PNG.bg;
    ctx.fillRect(0, 0, width, height);

    // Header
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = PNG.brand;
    ctx.font = '600 13px monospace';
    ctx.fillText('BIRDING TRACKER // CALENDAR · ' + String(result.valueLabel || '').toUpperCase(), PAD, titleTop + 12);

    ctx.fillStyle = PNG.title;
    fitFont(ctx, title, '700', 30, width - PAD * 2);
    ctx.fillText(title, PAD, titleTop + 18 + 30);

    if (subtitle) {
      ctx.fillStyle = PNG.muted;
      fitFont(ctx, subtitle, '500', 15, width - PAD * 2);
      ctx.fillText(subtitle, PAD, titleTop + 18 + 40 + 20);
    }

    // Divider
    ctx.strokeStyle = PNG.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, gridTop - 12);
    ctx.lineTo(width - PAD, gridTop - 12);
    ctx.stroke();

    var gridLeft = PAD + LABEL_W;
    var sumLeft = gridLeft + gridW + SUM_GAP;

    // Day header
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = PNG.muted;
    ctx.font = '600 11px ' + PNG.font;
    for (var d = 0; d < DAYS; d++) {
      ctx.fillText(String(d + 1), gridLeft + d * CELL + CELL / 2, gridTop + HEAD_H / 2);
      if (isWeekEndDay(d + 1)) {
        var tickX = gridLeft + (d + 1) * CELL;
        ctx.fillStyle = 'rgba(52, 211, 153, 0.65)';
        ctx.fillRect(tickX - 1, gridTop + 4, 2, HEAD_H - 8);
        ctx.fillStyle = PNG.muted;
      }
    }
    fitFont(ctx, 'Month', '700', 11, SUM_W - 8);
    ctx.fillText('Month', sumLeft + SUM_W / 2, gridTop + HEAD_H / 2);

    // Rows
    for (var m = 0; m < 12; m++) {
      var y = rowsTop + m * CELL;
      ctx.textAlign = 'left';
      ctx.fillStyle = PNG.muted;
      ctx.font = '700 13px ' + PNG.font;
      ctx.fillText(MONTHS[m], PAD, y + CELL / 2);

      for (var di = 0; di < DAYS; di++) {
        var x = gridLeft + di * CELL;
        var cx = x + GAP / 2;
        var cy = y + GAP / 2;
        var cs = CELL - GAP;
        var cell = cellAt(result, m, di);
        if (!cell) {
          ctx.fillStyle = PNG.invalidBg;
          roundRect(ctx, cx, cy, cs, cs, 4);
          ctx.fill();
          ctx.save();
          ctx.clip();
          ctx.strokeStyle = PNG.invalidLine;
          ctx.lineWidth = 1;
          for (var k = -cs; k < cs; k += 6) {
            ctx.beginPath();
            ctx.moveTo(cx + k, cy + cs);
            ctx.lineTo(cx + k + cs, cy);
            ctx.stroke();
          }
          ctx.restore();
          continue;
        }
        var v = isNumber(cell.value) ? cell.value : 0;
        if (v > 0) {
          var rgb = rgbFor(v, min, max);
          ctx.fillStyle = rgbString(rgb);
          roundRect(ctx, cx, cy, cs, cs, 4);
          ctx.fill();
          ctx.fillStyle = textColorFor(rgb);
          ctx.textAlign = 'center';
          fitFont(ctx, String(v), '700', 12, cs - 4);
          ctx.fillText(String(v), cx + cs / 2, cy + cs / 2 + 0.5);
        } else if (view === 'single') {
          ctx.strokeStyle = PNG.border;
          ctx.lineWidth = 1;
          roundRect(ctx, cx + 0.5, cy + 0.5, cs - 1, cs - 1, 4);
          ctx.stroke();
        } else {
          ctx.fillStyle = PNG.zeroBg;
          roundRect(ctx, cx, cy, cs, cs, 4);
          ctx.fill();
          ctx.fillStyle = PNG.zeroText;
          ctx.textAlign = 'center';
          ctx.font = '500 11px ' + PNG.font;
          ctx.fillText('0', cx + cs / 2, cy + cs / 2 + 0.5);
        }
      }

      // Summary column
      ctx.fillStyle = PNG.summaryBg;
      roundRect(ctx, sumLeft, y + GAP / 2, SUM_W, CELL - GAP, 4);
      ctx.fill();
      var s = summaries[m];
      var sText = isNumber(s) ? s.toLocaleString() : '–';
      ctx.fillStyle = PNG.title;
      ctx.textAlign = 'center';
      fitFont(ctx, sText, '700', 13, SUM_W - 8);
      ctx.fillText(sText, sumLeft + SUM_W / 2, y + CELL / 2 + 0.5);
    }

    // Legend
    var lx = gridLeft;
    var ly = legendTop + 10;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PNG.muted;
    ctx.font = '700 12px ' + PNG.font;
    var legendTitle = String(result.valueLabel || '').toUpperCase();
    ctx.fillText(legendTitle, lx, ly);
    lx += ctx.measureText(legendTitle).width + 16;

    ctx.font = '600 12px ' + PNG.font;
    if (max > 0) {
      if (max > min) {
        var minText = min.toLocaleString();
        ctx.fillStyle = PNG.muted;
        ctx.fillText(minText, lx, ly);
        lx += ctx.measureText(minText).width + 8;
        var barW = 240;
        var grad = ctx.createLinearGradient(lx, 0, lx + barW, 0);
        for (var g = 0; g <= 10; g++) grad.addColorStop(g / 10, rgbString(paletteRGB(g / 10)));
        ctx.fillStyle = grad;
        roundRect(ctx, lx, ly - 6, barW, 12, 6);
        ctx.fill();
        lx += barW + 8;
        ctx.fillStyle = PNG.muted;
        var maxText = max.toLocaleString();
        ctx.fillText(maxText, lx, ly);
        lx += ctx.measureText(maxText).width + 28;
      } else {
        ctx.fillStyle = colorFor(max, min, max);
        roundRect(ctx, lx, ly - 8, 16, 16, 3);
        ctx.fill();
        lx += 22;
        ctx.fillStyle = PNG.muted;
        var oneText = max.toLocaleString();
        ctx.fillText(oneText, lx, ly);
        lx += ctx.measureText(oneText).width + 28;
      }
    }

    // Zero / blank key
    if (view !== 'single') {
      ctx.fillStyle = PNG.zeroBg;
      roundRect(ctx, lx, ly - 8, 16, 16, 3);
      ctx.fill();
      ctx.fillStyle = PNG.zeroText;
      ctx.textAlign = 'center';
      ctx.font = '500 10px ' + PNG.font;
      ctx.fillText('0', lx + 8, ly + 0.5);
      ctx.textAlign = 'left';
      lx += 22;
      ctx.fillStyle = PNG.muted;
      ctx.font = '600 12px ' + PNG.font;
      ctx.fillText('none', lx, ly);
      lx += ctx.measureText('none').width + 20;
    } else {
      ctx.strokeStyle = PNG.border;
      roundRect(ctx, lx + 0.5, ly - 7.5, 15, 15, 3);
      ctx.stroke();
      lx += 22;
      ctx.fillStyle = PNG.muted;
      ctx.fillText('not recorded', lx, ly);
      lx += ctx.measureText('not recorded').width + 20;
    }
    ctx.fillStyle = PNG.invalidBg;
    roundRect(ctx, lx, ly - 8, 16, 16, 3);
    ctx.fill();
    ctx.strokeStyle = PNG.border;
    ctx.stroke();
    lx += 22;
    ctx.fillStyle = PNG.muted;
    ctx.fillText('no such date', lx, ly);

    // Footer: totals
    if (result.totals) {
      var t = result.totals;
      var yrs = Array.isArray(t.years) ? t.years : [];
      var foot = (t.checklists || 0).toLocaleString() + ' checklists · ' +
        (t.observations || 0).toLocaleString() + ' observations' +
        (yrs.length ? ' · ' + yrs[0] + (yrs.length > 1 ? '–' + yrs[yrs.length - 1] : '') : '');
      ctx.textAlign = 'right';
      ctx.fillStyle = PNG.faint;
      ctx.font = '500 12px ' + PNG.font;
      ctx.fillText(foot, width - PAD, ly);
    }

    return downloadCanvas(canvas, sanitizeFilename(options.filename));
  }

  function setLayoutMode(containerEl, mode) {
    if (!containerEl) return;
    var viewEl = containerEl.querySelector('.cal-view');
    if (!viewEl) return;
    viewEl.classList.remove('cal-view--scroll', 'cal-view--wrap', 'cal-view--fit');
    viewEl.classList.add('cal-view--' + mode);
    viewEl.setAttribute('data-layout-mode', mode);
  }

  var api = {
    renderMatrix: renderMatrix,
    setLayoutMode: setLayoutMode,
    exportPNG: exportPNG,
    colorFor: colorFor,
    // Extra helpers (non-contract, handy for tests/reuse)
    textColorForValue: function (value, min, max) {
      return textColorFor(rgbFor(value, min, max));
    },
    escapeHTML: escapeHTML
  };

  global.CalendarView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
