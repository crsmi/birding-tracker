/* ==========================================================================
   calendar-core.js — Pure data layer for the "Calendars" feature.
   Builds 12 x 31 (month x day) matrices from eBird observation records.
   No DOM, no dependencies. Attaches window.CalendarCore (browser) and
   module.exports (Node).

   Placement always uses month/day parsed from the `date` string
   ('YYYY-MM-DD'), never dayOfYear (which shifts in leap years).
   ========================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CalendarCore = api;
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null), function () {
  'use strict';

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Feb has 29 so that Feb 29 is a valid cell.
  const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /* -----------------------------------------------------------------------
     Helpers
     ----------------------------------------------------------------------- */

  /**
   * Parse a 'YYYY-MM-DD' string into { year, month (1-12), day (1-31) }.
   * Returns null for malformed strings or dates that do not exist on the
   * calendar matrix (e.g. Feb 30, Apr 31).
   */
  function parseMonthDay(dateStr) {
    if (typeof dateStr !== 'string' || dateStr.length < 10) return null;
    if (dateStr.charAt(4) !== '-' || dateStr.charAt(7) !== '-') return null;
    const year = parseInt(dateStr.substring(0, 4), 10);
    const month = parseInt(dateStr.substring(5, 7), 10);
    const day = parseInt(dateStr.substring(8, 10), 10);
    if (!(year > 0) || !(month >= 1 && month <= 12) || !(day >= 1)) return null;
    if (day > MONTH_LENGTHS[month - 1]) return null;
    if (month === 2 && day === 29 && !isLeapYear(year)) return null;
    return { year: year, month: month, day: day };
  }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  /** Creates a cached parser (dates repeat heavily across observations). */
  function makeDateCache() {
    const cache = new Map();
    return function (dateStr) {
      let v = cache.get(dateStr);
      if (v === undefined) {
        v = parseMonthDay(dateStr);
        cache.set(dateStr, v);
      }
      return v;
    };
  }

  /**
   * Creates a cached species-key resolver.
   * key = isTrueSpecies && !isNonCountable ? stripSubspecies(commonName) : null
   */
  function makeSpeciesKeyFn(rules) {
    const cache = new Map();
    return function (o) {
      const cn = o.commonName || '';
      const k = cn + '\u0001' + (o.scientificName || '') + '\u0001' + (o.state || '') + '\u0001' + (o.county || '');
      let v = cache.get(k);
      if (v === undefined) {
        v = null;
        if (rules.isTrueSpecies(cn, o.scientificName || '') &&
            !(rules.isNonCountable && rules.isNonCountable(cn, o.state || '', o.county || ''))) {
          v = rules.stripSubspecies(cn);
        }
        cache.set(k, v);
      }
      return v;
    };
  }

  function checklistIdOf(o) {
    return o.submissionId || o.id || '';
  }

  /** Index 0..371 for month (1-12) / day (1-31). */
  function cellIndex(month, day) {
    return (month - 1) * 31 + (day - 1);
  }

  /** Build a 12x31 grid; cellFactory(month, day) is called for valid dates only. */
  function makeGrid(cellFactory) {
    const cells = new Array(12);
    for (let m = 0; m < 12; m++) {
      const row = new Array(31);
      for (let d = 0; d < 31; d++) {
        row[d] = d < MONTH_LENGTHS[m] ? cellFactory(m + 1, d + 1) : null;
      }
      cells[m] = row;
    }
    return cells;
  }

  /** Compute min/max over valid cells (optionally only positive values). */
  function minMax(cells, positiveOnly) {
    let min = Infinity;
    let max = -Infinity;
    for (let m = 0; m < 12; m++) {
      for (let d = 0; d < 31; d++) {
        const c = cells[m][d];
        if (!c) continue;
        if (positiveOnly && !(c.value > 0)) continue;
        if (c.value < min) min = c.value;
        if (c.value > max) max = c.value;
      }
    }
    if (min === Infinity) return { min: 0, max: 0 };
    return { min: min, max: max };
  }

  /** Totals over the input observations. */
  function computeTotals(obs, parseDate) {
    const subs = new Set();
    const years = new Set();
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      subs.add(checklistIdOf(o));
      const p = parseDate(o.date);
      if (p) years.add(p.year);
      else if (o.year) years.add(o.year);
    }
    return {
      observations: obs.length,
      checklists: obs.length ? subs.size : 0,
      years: Array.from(years).sort(function (a, b) { return a - b; }),
    };
  }

  function sortedNumbers(set) {
    return Array.from(set).sort(function (a, b) { return a - b; });
  }

  /* -----------------------------------------------------------------------
     Filtering & lists
     ----------------------------------------------------------------------- */

  /**
   * Filter observations by inclusive date range (string compare on
   * 'YYYY-MM-DD') and/or exact locationId. Empty/absent filters are ignored.
   */
  function filterObservations(obs, filters) {
    const f = filters || {};
    const ds = f.dateStart || '';
    const de = f.dateEnd || '';
    const loc = f.locationId || '';
    if (!ds && !de && !loc) return obs.slice();
    const out = [];
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const date = o.date || '';
      if (ds && date < ds) continue;
      if (de && date > de) continue;
      if (loc && o.locationId !== loc) continue;
      out.push(o);
    }
    return out;
  }

  /** Earliest / latest date strings in obs, or null when empty. */
  function getDateSpan(obs) {
    let min = null;
    let max = null;
    for (let i = 0; i < obs.length; i++) {
      const d = obs[i].date;
      if (!d) continue;
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
    return min === null ? null : { min: min, max: max };
  }

  /** [{ locationId, location, county, state, checklistCount }] sorted by location name. */
  function buildLocationList(obs) {
    const map = new Map();
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const id = o.locationId || '';
      if (!id) continue;
      let e = map.get(id);
      if (!e) {
        e = { locationId: id, location: o.location || id, county: o.county || '', state: o.state || '', subs: new Set() };
        map.set(id, e);
      }
      e.subs.add(checklistIdOf(o));
    }
    const list = [];
    map.forEach(function (e) {
      list.push({ locationId: e.locationId, location: e.location, county: e.county, state: e.state, checklistCount: e.subs.size });
    });
    list.sort(function (a, b) {
      const c = a.location.localeCompare(b.location);
      return c !== 0 ? c : a.locationId.localeCompare(b.locationId);
    });
    return list;
  }

  /**
   * [{ name, taxonomicOrder, checklistCount }] — parent species of true-species
   * observations (exotic exclusions NOT applied), sorted by taxonomicOrder.
   */
  function buildSpeciesList(obs, rules) {
    const map = new Map();
    const trueCache = new Map();
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const cn = o.commonName || '';
      const ck = cn + '\u0001' + (o.scientificName || '');
      let name = trueCache.get(ck);
      if (name === undefined) {
        name = rules.isTrueSpecies(cn, o.scientificName || '') ? rules.stripSubspecies(cn) : null;
        trueCache.set(ck, name);
      }
      if (!name) continue;
      let e = map.get(name);
      const tax = o.taxonomicOrder || 0;
      if (!e) {
        e = { name: name, taxonomicOrder: tax, subs: new Set() };
        map.set(name, e);
      } else if (tax && (!e.taxonomicOrder || tax < e.taxonomicOrder)) {
        e.taxonomicOrder = tax;
      }
      e.subs.add(checklistIdOf(o));
    }
    const list = [];
    map.forEach(function (e) {
      list.push({ name: e.name, taxonomicOrder: e.taxonomicOrder, checklistCount: e.subs.size });
    });
    list.sort(function (a, b) {
      const ta = a.taxonomicOrder || Infinity;
      const tb = b.taxonomicOrder || Infinity;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  /* -----------------------------------------------------------------------
     Computations
     ----------------------------------------------------------------------- */

  /** View 'species': distinct countable species seen on each MM-DD (all years pooled). */
  function computeTotalSpecies(obs, rules) {
    const parseDate = makeDateCache();
    const speciesKey = makeSpeciesKeyFn(rules);
    const cellSpecies = new Array(372);
    const cellYears = new Array(372);
    const cellSubs = new Array(372);
    const monthSpecies = [];
    for (let m = 0; m < 12; m++) monthSpecies.push(new Set());

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const p = parseDate(o.date);
      if (!p) continue;
      const idx = cellIndex(p.month, p.day);
      let subs = cellSubs[idx];
      if (!subs) { subs = cellSubs[idx] = new Set(); }
      subs.add(checklistIdOf(o));
      const key = speciesKey(o);
      if (key === null) continue;
      let sp = cellSpecies[idx];
      if (!sp) { sp = cellSpecies[idx] = new Set(); cellYears[idx] = new Set(); }
      sp.add(key);
      cellYears[idx].add(p.year);
      monthSpecies[p.month - 1].add(key);
    }

    const cells = makeGrid(function (month, day) {
      const idx = cellIndex(month, day);
      return {
        month: month,
        day: day,
        value: cellSpecies[idx] ? cellSpecies[idx].size : 0,
        details: {
          years: cellYears[idx] ? sortedNumbers(cellYears[idx]) : [],
          checklists: cellSubs[idx] ? cellSubs[idx].size : 0,
        },
      };
    });
    const mm = minMax(cells, false);
    return {
      view: 'species',
      valueLabel: 'species',
      cells: cells,
      min: mm.min,
      max: mm.max,
      rowSummaries: monthSpecies.map(function (s) { return s.size; }),
      summaryLabel: 'Month species',
      totals: computeTotals(obs, parseDate),
    };
  }

  /** View 'checklists': distinct checklists on each MM-DD (all years pooled). */
  function computeTotalChecklists(obs) {
    const parseDate = makeDateCache();
    const seen = new Set();
    const counts = new Array(372).fill(0);
    const cellYears = new Array(372);
    const monthCounts = new Array(12).fill(0);

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const sid = checklistIdOf(o);
      if (seen.has(sid)) continue;
      const p = parseDate(o.date);
      if (!p) continue;
      seen.add(sid);
      const idx = cellIndex(p.month, p.day);
      counts[idx]++;
      let y = cellYears[idx];
      if (!y) { y = cellYears[idx] = {}; }
      y[p.year] = (y[p.year] || 0) + 1;
      monthCounts[p.month - 1]++;
    }

    const cells = makeGrid(function (month, day) {
      const idx = cellIndex(month, day);
      return { month: month, day: day, value: counts[idx], details: { years: cellYears[idx] || {} } };
    });
    const mm = minMax(cells, false);
    return {
      view: 'checklists',
      valueLabel: 'checklists',
      cells: cells,
      min: mm.min,
      max: mm.max,
      rowSummaries: monthCounts,
      summaryLabel: 'Month checklists',
      totals: computeTotals(obs, parseDate),
    };
  }

  /**
   * View 'single': distinct checklists containing the species on each MM-DD.
   * Matches true-species obs where stripSubspecies(commonName) === speciesName
   * (excludes domestic types, hybrids, slashes, and spuhs).
   */
  function computeSingleSpecies(obs, speciesName, rules) {
    const parseDate = makeDateCache();
    const matchCache = new Map();
    const cellSubs = new Array(372);
    const cellYears = new Array(372);
    const monthSubs = [];
    for (let m = 0; m < 12; m++) monthSubs.push(new Set());
    const matchedSubs = new Set();
    const matchedYears = new Set();
    let matchedObsCount = 0;

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const cn = o.commonName || '';
      const sn = o.scientificName || '';
      const ck = cn + '\u0001' + sn;
      let match = matchCache.get(ck);
      if (match === undefined) {
        match = !!speciesName &&
          rules.isTrueSpecies(cn, sn) &&
          rules.stripSubspecies(cn) === speciesName;
        matchCache.set(ck, match);
      }
      if (!match) continue;
      matchedObsCount++;
      const sid = checklistIdOf(o);
      matchedSubs.add(sid);
      const p = parseDate(o.date);
      if (!p) {
        if (o.year) matchedYears.add(o.year);
        continue;
      }
      matchedYears.add(p.year);
      const idx = cellIndex(p.month, p.day);
      let s = cellSubs[idx];
      if (!s) { s = cellSubs[idx] = new Set(); cellYears[idx] = new Set(); }
      s.add(sid);
      cellYears[idx].add(p.year);
      monthSubs[p.month - 1].add(sid);
    }

    const cells = makeGrid(function (month, day) {
      const idx = cellIndex(month, day);
      return {
        month: month,
        day: day,
        value: cellSubs[idx] ? cellSubs[idx].size : 0,
        details: { years: cellYears[idx] ? sortedNumbers(cellYears[idx]) : [] },
      };
    });
    const mm = minMax(cells, true);
    return {
      view: 'single',
      valueLabel: 'checklists with species',
      cells: cells,
      min: mm.min,
      max: mm.max,
      rowSummaries: monthSubs.map(function (s) { return s.size; }),
      summaryLabel: 'Month checklists',
      totals: {
        observations: matchedObsCount,
        checklists: matchedObsCount ? matchedSubs.size : 0,
        years: sortedNumbers(matchedYears),
      },
    };
  }

  /**
   * View 'bigday': for each MM-DD, the maximum number of distinct countable
   * species recorded on any single calendar date (any year) falling on it.
   */
  function computeBigDay(obs, rules) {
    const parseDate = makeDateCache();
    const speciesKey = makeSpeciesKeyFn(rules);
    // date string -> { species:Set, locations:Set, p }
    const byDate = new Map();

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const key = speciesKey(o);
      if (key === null) continue;
      const p = parseDate(o.date);
      if (!p) continue;
      let e = byDate.get(o.date);
      if (!e) {
        e = { species: new Set(), locations: new Set(), p: p };
        byDate.set(o.date, e);
      }
      e.species.add(key);
      if (o.location) e.locations.add(o.location);
    }

    const best = new Array(372).fill(0);
    const records = new Array(372);
    byDate.forEach(function (e, date) {
      const idx = cellIndex(e.p.month, e.p.day);
      const n = e.species.size;
      if (n > best[idx]) {
        best[idx] = n;
        records[idx] = [{ date: date, count: n, locations: Array.from(e.locations).sort() }];
      } else if (n === best[idx] && n > 0) {
        records[idx].push({ date: date, count: n, locations: Array.from(e.locations).sort() });
      }
    });

    const rowBest = new Array(12).fill(0);
    const cells = makeGrid(function (month, day) {
      const idx = cellIndex(month, day);
      const recs = records[idx] || [];
      recs.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
      if (best[idx] > rowBest[month - 1]) rowBest[month - 1] = best[idx];
      return { month: month, day: day, value: best[idx], details: { records: recs } };
    });
    const mm = minMax(cells, false);
    return {
      view: 'bigday',
      valueLabel: 'species (record day)',
      cells: cells,
      min: mm.min,
      max: mm.max,
      rowSummaries: rowBest,
      summaryLabel: 'Month best',
      totals: computeTotals(obs, parseDate),
    };
  }

  /* -----------------------------------------------------------------------
     Export
     ----------------------------------------------------------------------- */

  function csvField(v) {
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** CSV: header Month,1..31,<summaryLabel>; 12 month rows; invalid dates empty. */
  function toCSV(result) {
    const header = ['Month'];
    for (let d = 1; d <= 31; d++) header.push(String(d));
    header.push(result.summaryLabel);
    const lines = [header.map(csvField).join(',')];
    for (let m = 0; m < 12; m++) {
      const row = [MONTH_NAMES[m]];
      for (let d = 0; d < 31; d++) {
        const c = result.cells[m][d];
        row.push(c ? String(c.value || 0) : '');
      }
      row.push(String(result.rowSummaries[m] || 0));
      lines.push(row.map(csvField).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  return {
    MONTH_NAMES: MONTH_NAMES,
    MONTH_LENGTHS: MONTH_LENGTHS,
    parseMonthDay: parseMonthDay,
    filterObservations: filterObservations,
    getDateSpan: getDateSpan,
    buildLocationList: buildLocationList,
    buildSpeciesList: buildSpeciesList,
    computeTotalSpecies: computeTotalSpecies,
    computeTotalChecklists: computeTotalChecklists,
    computeSingleSpecies: computeSingleSpecies,
    computeBigDay: computeBigDay,
    toCSV: toCSV,
  };
});
