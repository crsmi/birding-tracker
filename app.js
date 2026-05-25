/* ==========================================================================
   app.js — Main Application Controller for eBird YoY Species Tracker
   
   This application is designed to work by opening index.html directly
   in a browser (file:// protocol). No server required.
   
   PapaParse and JSZip are loaded via CDN <script> tags in index.html.
   CSV parsing runs on the main thread using PapaParse's streaming mode
   with periodic yields to prevent UI blocking.
   ========================================================================== */

(function () {
  'use strict';

  const SYSTEM_EXCLUSIONS = [
    { id: 'sys-whooper-swan-wi', commonName: 'Whooper Swan', state: 'US-WI', county: '' },
    { id: 'sys-mandarin-duck-wi', commonName: 'Mandarin Duck', state: 'US-WI', county: '' },
    { id: 'sys-egyptian-goose-wi', commonName: 'Egyptian Goose', state: 'US-WI', county: '' },
    { id: 'sys-chukar-wi', commonName: 'Chukar', state: 'US-WI', county: '' }
  ];

  /* -----------------------------------------------------------------------
     1. State
     ----------------------------------------------------------------------- */
  const state = {
    observations: [],        // All observations for current filter
    speciesData: [],         // Computed species grid data
    targets: new Map(),      // commonName -> { isTarget, addedAt }
    regions: [],             // [{state, county}]
    userExclusions: [],      // Array of custom exotics exclusions: [{ id, commonName, state, county }]
    disabledSystemExclusions: [], // Array of disabled default exotics IDs
    filterState: '',
    filterCounty: '',
    targetYear: new Date().getFullYear(),
    simDate: new Date(),
    searchQuery: '',
    aggregateSubspecies: true,
    showTrueSpeciesOnly: true,
    targetsOnly: false,
    pastDueOnly: false,
    yearFilters: {},         // year -> 'all'|'seen'|'unseen'
    sortColumn: 'taxonomicOrder',
    sortDirection: 'asc',
    isDataLoaded: false,

    // Tick Explorer State
    activeTab: 'yoy',
    tickMilestones: [],
    tickSearchQuery: '',
    tickDateStart: '',
    tickDateEnd: '',
    selectedMapCounty: '',
    tickChartInstance: null,
    visualCentroids: new Map(),
    tickSortColumn: 'speciesCount',
    tickSortDirection: 'desc',
  };

  /* -----------------------------------------------------------------------
     2. DOM References
     ----------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const DOM = {
    inputFile: $('input-file'),
    inputFileDrop: $('input-file-drop'),
    dropZone: $('drop-zone'),
    btnLoadMock: $('btn-load-mock'),
    btnLoadMockMain: $('btn-load-mock-main'),
    btnExportState: $('btn-export-state'),
    inputImportState: $('input-import-state'),
    btnClearData: $('btn-clear-data'),
    filterState: $('filter-state'),
    filterCounty: $('filter-county'),
    filterYear: $('filter-year'),
    filterSimDate: $('filter-sim-date'),
    filterSearch: $('filter-search'),
    toggleAggregate: $('toggle-aggregate'),
    toggleTrueSpecies: $('toggle-true-species'),
    toggleTargetsOnly: $('toggle-targets-only'),
    togglePastDueOnly: $('toggle-past-due-only'),
    statsBar: $('stats-bar'),
    statBarSpecies: $('stat-bar-species'),
    statBarTargets: $('stat-bar-targets'),
    statBarPastDue: $('stat-bar-pastdue'),
    statBarYear: $('stat-bar-year'),
    statBarSimDate: $('stat-bar-simdate'),
    statTotalRecords: $('stat-total-records'),
    statTotalSpecies: $('stat-total-species'),
    statDateAsOf: $('stat-date-as-of'),
    alertsPanel: $('alerts-panel'),
    alertsList: $('alerts-list'),
    btnToggleAlerts: $('btn-toggle-alerts'),
    emptyState: $('empty-state'),
    gridWrapper: $('grid-wrapper'),
    gridHeaderRow: $('grid-header-row'),
    gridBody: $('grid-body'),
    loadingOverlay: $('loading-overlay'),
    loadingText: $('loading-text'),
    importProgress: $('import-progress'),
    importProgressFill: $('import-progress-fill'),
    importStatus: $('import-status'),
    toastContainer: $('toast-container'),

    // Tick Explorer DOM
    tabYoY: $('tab-yoy'),
    tabTick: $('tab-tick'),
    tickExplorerWrapper: $('tick-explorer-wrapper'),
    tickStatTotal: $('tick-stat-total'),
    tickStatCounties: $('tick-stat-counties'),
    tickStatTop: $('tick-stat-top'),
    tickStatTopCount: $('tick-stat-top-count'),
    tickDateStart: $('tick-date-start'),
    tickDateEnd: $('tick-date-end'),
    btnClearDateFilter: $('btn-clear-date-filter'),
    tickSearchSubregions: $('tick-search-subregions'),
    subregionListBody: $('subregion-list-body'),
    timelineAdditionsList: $('timeline-additions-list'),
    timelineAdditionsTitle: $('timeline-additions-title'),
    tickSvgMap: $('tick-svg-map'),
    mapNodesLayer: $('map-nodes-layer'),
    mapEdgesLayer: $('map-edges-layer'),
    mapLabelsLayer: $('map-labels-layer'),
    mapTooltip: $('map-tooltip'),
    mapColorMode: $('map-color-mode'),
    mapLegendMin: $('map-legend-min'),
    mapLegendMax: $('map-legend-max'),
    analyzerSummary: $('tick-analyzer-summary'),
    analyzerStart: $('tick-analyzer-start'),
    analyzerEnd: $('tick-analyzer-end'),
    analyzerAdded: $('tick-analyzer-added'),
    btnDownloadMap: $('btn-download-map'),
    btnDownloadCsv: $('btn-download-csv'),
    btnEbirdLifelist: $('btn-ebird-lifelist'),
    btnMapZoomOut: $('btn-map-zoom-out'),
    tickLevel: $('tick-level'),
    toggleExportInfographic: $('toggle-export-infographic'),
    tickStatTotalLabel: $('tick-stat-total-label'),
    tickStatCountiesLabel: $('tick-stat-counties-label'),
    tickStatTopLabel: $('tick-stat-top-label'),
    tickStatTotalDesc: $('tick-stat-total-desc'),
    tickStatCountiesDesc: $('tick-stat-counties-desc'),

    // Settings DOM
    tabSettings: $('tab-settings'),
    settingsWrapper: $('settings-wrapper'),
    exclusionSpecies: $('exclusion-species'),
    datalistSpecies: $('datalist-species'),
    exclusionState: $('exclusion-state'),
    exclusionCounty: $('exclusion-county'),
    formAddExclusion: $('form-add-exclusion'),
    userExclusionsBody: $('user-exclusions-body'),
    systemExclusionsBody: $('system-exclusions-body'),
  };

  /* -----------------------------------------------------------------------
     3. Utilities
     ----------------------------------------------------------------------- */

  /** Convert day-of-year (1-366) to a readable label like "May 12". */
  function dayOfYearToLabel(doy) {
    const d = new Date(2023, 0, 1);
    d.setDate(doy);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }

  /** Convert a Date object to a day-of-year integer. */
  function dateToDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    return Math.floor(diff / 86400000);
  }

  /** Format a Date to YYYY-MM-DD. */
  function formatDateISO(d) {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
  }

  /** Format a Date to a short label like "May 24, 2026". */
  function formatDateLabel(d) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /** Strip subspecies parenthetical. */
  function stripSubspecies(name) {
    const idx = name.indexOf(' (');
    return idx === -1 ? name : name.substring(0, idx);
  }

  /** Check if a species name is a true species (excluding spuhs, slashes, hybrids, domestic). */
  function isTrueSpecies(commonName, scientificName) {
    const c = (commonName || '').toLowerCase();
    const s = (scientificName || '').toLowerCase();

    // Slashes (only check common name, e.g. Cooper's/Sharp-shinned Hawk, as subspecies group scientific names may contain slashes)
    if (c.includes('/')) return false;

    // Spuhs (ends with ' sp.' or ' sp' or contains ' sp.')
    if (c.includes(' sp.') || c.endsWith(' sp') || s.includes(' sp.') || s.endsWith(' sp')) return false;

    // Hybrids (contains ' x ' with spaces, or 'hybrid')
    if (c.includes(' x ') || s.includes(' x ') || c.includes('hybrid') || s.includes('hybrid')) return false;

    // Domestic (must contain parenthesis like '(domestic' or '(domestic type)' to avoid matching true species like House Sparrow 'Passer domesticus')
    if (c.includes('(domestic') || s.includes('(domestic')) return false;

    return true;
  }

  /** Debounce utility. */
  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /** Escape HTML for safe insertion. */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** Check if a species sighting is non-countable in the given region (custom user rules or enabled system rules). */
  function isNonCountable(obsCommonName, obsState, obsCounty) {
    const name = (obsCommonName || '').trim().toLowerCase();
    const sName = stripSubspecies(obsCommonName || '').trim().toLowerCase();
    const s = (obsState || '').trim().toLowerCase();
    const c = (obsCounty || '').trim().toLowerCase();

    // Check user exclusions
    if (state.userExclusions && Array.isArray(state.userExclusions)) {
      for (const rule of state.userExclusions) {
        const rName = (rule.commonName || '').trim().toLowerCase();
        if (rName === name || rName === sName) {
          const rState = (rule.state || '').trim().toLowerCase();
          const rCounty = (rule.county || '').trim().toLowerCase();

          // Rule matches if it has no state, or state matches
          if (!rState || rState === s) {
            // Rule matches if it has no county, or county matches
            if (!rCounty || rCounty === c) {
              return true;
            }
          }
        }
      }
    }

    // Check system exclusions
    if (SYSTEM_EXCLUSIONS && Array.isArray(SYSTEM_EXCLUSIONS)) {
      for (const rule of SYSTEM_EXCLUSIONS) {
        // Skip if this system rule has been disabled by the user
        if (state.disabledSystemExclusions && state.disabledSystemExclusions.includes(rule.id)) {
          continue;
        }

        const rName = (rule.commonName || '').trim().toLowerCase();
        if (rName === name || rName === sName) {
          const rState = (rule.state || '').trim().toLowerCase();
          const rCounty = (rule.county || '').trim().toLowerCase();

          if (!rState || rState === s) {
            if (!rCounty || rCounty === c) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /* -----------------------------------------------------------------------
     4. Toast Notifications
     ----------------------------------------------------------------------- */
  function showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    DOM.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--removing');
      toast.addEventListener('animationend', () => toast.remove());
    }, duration);
  }

  /* -----------------------------------------------------------------------
     5. Loading State
     ----------------------------------------------------------------------- */
  function showLoading(text) {
    DOM.loadingOverlay.classList.remove('is-hidden');
    DOM.loadingText.textContent = text || 'Processing...';
  }
  function hideLoading() {
    DOM.loadingOverlay.classList.add('is-hidden');
  }

  /* -----------------------------------------------------------------------
     6. CSV Parsing Utilities
     ----------------------------------------------------------------------- */

  /**
   * Robust date parser supporting YYYY-MM-DD and DD MMM YYYY (e.g. 24 May 2026) formats.
   * @returns {Date|null}
   */
  function parseRobustDate(dateStr) {
    if (!dateStr) return null;
    const str = dateStr.trim();

    // Standard ISO: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const d = new Date(str + 'T00:00:00');
      return isNaN(d.getTime()) ? null : d;
    }

    // DD MMM YYYY (e.g., 24 May 2026)
    const match = str.match(/^(\d{1,2})\s+([A-Za-z]{3,10})\s+(\d{4})$/);
    if (match) {
      const day = parseInt(match[1], 10);
      const monthStr = match[2].substring(0, 3).toLowerCase();
      const year = parseInt(match[3], 10);
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const month = months.indexOf(monthStr);
      if (month !== -1) {
        return new Date(year, month, day);
      }
    }

    // Fallback
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }



  /**
   * Parse CSV text using PapaParse and return structured records.
   * Uses chunked parsing with async yields to keep UI responsive.
   */
  function parseCSVText(csvText, onProgress) {
    return new Promise((resolve, reject) => {
      const results = [];
      let rowCount = 0;
      const totalEstimate = (csvText.match(/\n/g) || []).length;

      Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        chunk: function (chunk, parser) {
          for (const d of chunk.data) {
            rowCount++;
            const submissionId = d['Submission ID'] || d['SubID'] || '';
            const commonName = (d['Common Name'] || '').trim();
            const scientificName = (d['Scientific Name'] || '').trim();
            const taxonomicOrder = parseInt(d['Taxonomic Order'] || d['Taxon Order'], 10) || 0;
            const countRaw = d['Count'] || '0';
            const count = countRaw === 'X' ? 1 : parseInt(countRaw, 10) || 0;
            const stateVal = (d['State/Province'] || d['S/P'] || '').trim();
            let county = (d['County'] || '').trim();
            const locationId = (d['Location ID'] || d['LocID'] || '').trim();
            const location = (d['Location'] || '').trim();
            const latitude = parseFloat(d['Latitude']) || 0;
            const longitude = parseFloat(d['Longitude']) || 0;
            const dateStr = (d['Date'] || '').trim();
            const time = (d['Time'] || '').trim();
            const protocol = (d['Protocol'] || '').trim();
            const duration = parseInt(d['Duration (Min)'], 10) || 0;
            const allObs = d['All Obs Reported'] === '1';
            const breedingCode = (d['Breeding Code'] || '').trim();
            const obsDetails = (d['Observation Details'] || '').trim();

            if (!commonName || !dateStr) continue;

            const parsedDate = parseRobustDate(dateStr);
            if (!parsedDate) continue;

            const yearNum = parsedDate.getFullYear();
            const dayOfYear = dateToDayOfYear(parsedDate);

            // Dynamic County parsing fallback from location
            if (!county && location) {
              const countyMatch = location.match(/\(([^)]+?)\s+(?:Co\.|County)\)/i);
              if (countyMatch) {
                county = countyMatch[1].trim();
              }
            }

            const id = (submissionId || ('ROW_' + rowCount)) + '::' + commonName;

            results.push({
              id,
              submissionId,
              commonName,
              scientificName,
              taxonomicOrder,
              count,
              state: stateVal,
              county,
              locationId,
              location,
              latitude,
              longitude,
              date: formatDateISO(parsedDate),
              time,
              year: yearNum,
              dayOfYear,
              protocol,
              duration,
              allObs,
              breedingCode,
              obsDetails,
            });
          }

          if (onProgress) {
            onProgress(rowCount, totalEstimate);
          }
        },
        complete: function () {
          resolve(results);
        },
        error: function (error) {
          reject(new Error(error.message || 'CSV parse error'));
        },
      });
    });
  }

  /* -----------------------------------------------------------------------
     7. File Import
     ----------------------------------------------------------------------- */

  async function handleFileImport(file) {
    if (!file) return;

    const name = file.name.toLowerCase();
    const isZip = name.endsWith('.zip');
    const isCSV = name.endsWith('.csv');

    if (!isZip && !isCSV) {
      showToast('Please select a .csv or .zip file from eBird.', 'error');
      return;
    }

    // Show progress UI
    DOM.importProgress.style.display = 'block';
    DOM.importStatus.style.display = 'block';
    DOM.importProgressFill.style.width = '0%';
    DOM.importStatus.textContent = 'Reading file...';
    showLoading('Reading file...');

    try {
      let csvText;

      if (isZip) {
        DOM.importStatus.textContent = 'Decompressing ZIP archive...';
        DOM.loadingText.textContent = 'Decompressing ZIP...';

        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const csvFiles = Object.keys(zip.files).filter(
          (n) => n.toLowerCase().endsWith('.csv') && !n.startsWith('__MACOSX')
        );

        if (csvFiles.length === 0) {
          throw new Error('No CSV file found inside the ZIP archive.');
        }

        csvText = await zip.files[csvFiles[0]].async('string');
      } else {
        csvText = await file.text();
      }

      DOM.importStatus.textContent = 'Parsing CSV data...';
      DOM.loadingText.textContent = 'Parsing CSV...';

      const records = await parseCSVText(csvText, (current, total) => {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        DOM.importProgressFill.style.width = pct + '%';
        DOM.importStatus.textContent = `Parsing: ${current.toLocaleString()} / ~${total.toLocaleString()} rows`;
        DOM.loadingText.textContent = `Parsing: ${pct}%`;
      });

      DOM.importStatus.textContent = 'Clearing previous observations...';
      DOM.loadingText.textContent = 'Clearing database...';
      await DB.clearObservations();

      DOM.importStatus.textContent = `Storing ${records.length.toLocaleString()} records...`;
      DOM.loadingText.textContent = 'Storing data...';

      // Store in batches
      const BATCH_SIZE = 10000;
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        await DB.putObservations(batch);
        const storePct = Math.round(((i + batch.length) / records.length) * 100);
        DOM.importProgressFill.style.width = storePct + '%';
      }

      DOM.importProgressFill.style.width = '100%';
      DOM.importStatus.textContent = `Import complete: ${records.length.toLocaleString()} records loaded.`;
      showToast(`Successfully imported ${records.length.toLocaleString()} observations!`, 'success');

      hideLoading();
      await initDashboard();

    } catch (err) {
      hideLoading();
      DOM.importStatus.textContent = 'Error: ' + err.message;
      showToast('Import error: ' + err.message, 'error');
      console.error('Import error:', err);
    }
  }

  function generateMockData() {
    showLoading('Generating mock eBird data...');

    DOM.importProgress.style.display = 'block';
    DOM.importStatus.style.display = 'block';
    DOM.importProgressFill.style.width = '0%';
    DOM.importStatus.textContent = 'Clearing previous observations...';
    DOM.loadingText.textContent = 'Clearing DB...';

    DB.clearObservations().then(() => {
      DOM.importProgressFill.style.width = '10%';
      DOM.importStatus.textContent = 'Creating mock observations...';
      DOM.loadingText.textContent = 'Creating data...';

      const MOCK_SPECIES = [
        // Residents
        { common: 'Northern Cardinal', scientific: 'Cardinalis cardinalis', order: 100, resident: true },
        { common: 'Blue Jay', scientific: 'Cyanocitta cristata', order: 101, resident: true },
        { common: 'American Crow', scientific: 'Corvus brachyrhynchos', order: 102, resident: true },
        { common: 'Black-capped Chickadee', scientific: 'Poecile atricapillus', order: 103, resident: true },
        { common: 'White-breasted Nuthatch', scientific: 'Sitta carolinensis', order: 104, resident: true },
        { common: 'Downy Woodpecker', scientific: 'Dryobates pubescens', order: 105, resident: true },
        { common: 'Red-bellied Woodpecker', scientific: 'Melanerpes carolinus', order: 106, resident: true },
        { common: 'House Sparrow', scientific: 'Passer domesticus', order: 107, resident: true },
        { common: 'American Goldfinch', scientific: 'Spinus tristis', order: 108, resident: true },
        { common: 'Tufted Titmouse', scientific: 'Baeolophus bicolor', order: 109, resident: true },
        { common: 'Dark-eyed Junco', scientific: 'Junco hyemalis', order: 110, resident: true },
        { common: 'House Finch', scientific: 'Haemorhous mexicanus', order: 111, resident: true },
        { common: 'Mourning Dove', scientific: 'Zenaida macroura', order: 112, resident: true },
        { common: 'Red-tailed Hawk', scientific: 'Buteo jamaicensis', order: 113, resident: true },
        { common: 'Cooper\'s Hawk', scientific: 'Accipiter cooperii', order: 114, resident: true },

        // Summer breeders
        { common: 'Baltimore Oriole', scientific: 'Icterus galbula', order: 200, earliest: 115, latest: 270 },
        { common: 'Ruby-throated Hummingbird', scientific: 'Archilochus colubris', order: 201, earliest: 120, latest: 280 },
        { common: 'Indigo Bunting', scientific: 'Passerina cyanea', order: 202, earliest: 125, latest: 265 },
        { common: 'Rose-breasted Grosbeak', scientific: 'Pheucticus ludovicianus', order: 203, earliest: 118, latest: 268 },
        { common: 'Eastern Kingbird', scientific: 'Tyrannus tyrannus', order: 204, earliest: 120, latest: 260 },
        { common: 'Barn Swallow', scientific: 'Hirundo rustica', order: 205, earliest: 100, latest: 275 },
        { common: 'Red-eyed Vireo', scientific: 'Vireo olivaceus', order: 206, earliest: 122, latest: 270 },
        { common: 'Scarlet Tanager', scientific: 'Piranga olivacea', order: 207, earliest: 125, latest: 265 },
        { common: 'Wood Thrush', scientific: 'Hylocichla mustelina', order: 208, earliest: 118, latest: 265 },
        { common: 'Great Crested Flycatcher', scientific: 'Myiarchus crinitus', order: 209, earliest: 120, latest: 258 },
        { common: 'Eastern Bluebird', scientific: 'Sialia sialis', order: 210, earliest: 60, latest: 320 },
        { common: 'Gray Catbird', scientific: 'Dumetella carolinensis', order: 211, earliest: 115, latest: 285 },
        { common: 'Common Yellowthroat', scientific: 'Geothlypis trichas', order: 212, earliest: 115, latest: 275 },
        { common: 'Yellow Warbler', scientific: 'Setophaga petechia', order: 213, earliest: 118, latest: 255 },
        { common: 'American Redstart', scientific: 'Setophaga ruticilla', order: 214, earliest: 122, latest: 260 },

        // Transient warblers
        { common: 'Blackburnian Warbler', scientific: 'Setophaga fusca', order: 300, earliest: 125, latest: 145 },
        { common: 'Black-throated Green Warbler', scientific: 'Setophaga virens', order: 301, earliest: 120, latest: 150 },
        { common: 'Cape May Warbler', scientific: 'Setophaga tigrina', order: 302, earliest: 128, latest: 148 },
        { common: 'Bay-breasted Warbler', scientific: 'Setophaga castanea', order: 303, earliest: 130, latest: 150 },
        { common: 'Tennessee Warbler', scientific: 'Leiothlypis peregrina', order: 304, earliest: 118, latest: 148 },
        { common: 'Magnolia Warbler', scientific: 'Setophaga magnolia', order: 305, earliest: 120, latest: 150 },
        { common: 'Chestnut-sided Warbler', scientific: 'Setophaga pensylvanica', order: 306, earliest: 122, latest: 148 },

        // Subspecies examples
        { common: 'Yellow-rumped Warbler (Myrtle)', scientific: 'Setophaga coronata coronata', order: 310, earliest: 100, latest: 290 },
        { common: 'Yellow-rumped Warbler (Audubon\'s)', scientific: 'Setophaga coronata auduboni', order: 311, earliest: 105, latest: 285 },
        { common: 'Dark-eyed Junco (Slate-colored)', scientific: 'Junco hyemalis hyemalis', order: 312, resident: true },

        // Winter visitors
        { common: 'Snowy Owl', scientific: 'Bubo scandiacus', order: 400, earliest: 310, latest: 80, winter: true },
        { common: 'Common Redpoll', scientific: 'Acanthis flammea', order: 401, earliest: 315, latest: 90, winter: true },
        { common: 'Pine Siskin', scientific: 'Spinus pinus', order: 402, earliest: 280, latest: 120, winter: true },

        // Waterbirds
        { common: 'Great Blue Heron', scientific: 'Ardea herodias', order: 500, earliest: 70, latest: 320 },
        { common: 'Green Heron', scientific: 'Butorides virescens', order: 501, earliest: 115, latest: 270 },
        { common: 'Mallard', scientific: 'Anas platyrhynchos', order: 502, resident: true },
        { common: 'Wood Duck', scientific: 'Aix sponsa', order: 503, earliest: 70, latest: 310 },
        { common: 'Canada Goose', scientific: 'Branta canadensis', order: 504, resident: true },
        { common: 'Sandhill Crane', scientific: 'Antigone canadensis', order: 505, earliest: 65, latest: 320 },
        { common: 'Killdeer', scientific: 'Charadrius vociferus', order: 506, earliest: 60, latest: 310 },

        // Non-true species (spuhs, slashes, hybrids, domestic)
        { common: 'gull sp.', scientific: 'Laridae sp.', order: 900, resident: true },
        { common: "Cooper's/Sharp-shinned Hawk", scientific: 'Accipiter cooperii/striatus', order: 901, earliest: 50, latest: 320 },
        { common: 'Mallard x American Black Duck hybrid', scientific: 'Anas platyrhynchos x rubripes', order: 902, resident: true },
        { common: 'Mallard (Domestic type)', scientific: 'Anas platyrhynchos (Domestic type)', order: 903, resident: true },
      ];

      const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
      const STATE = 'US-WI';
      const LOCATIONS = [
        { name: 'Pheasant Branch Conservancy', id: 'L123456', lat: 43.107, lng: -89.529, county: 'Dane' },
        { name: 'UW Arboretum', id: 'L234567', lat: 43.041, lng: -89.427, county: 'Dane' },
        { name: 'Picnic Point', id: 'L345678', lat: 43.089, lng: -89.419, county: 'Dane' },
        { name: 'Governor Nelson State Park', id: 'L456789', lat: 43.152, lng: -89.512, county: 'Dane' },
        { name: 'Cherokee Marsh', id: 'L567890', lat: 43.140, lng: -89.362, county: 'Dane' },
        { name: 'Swan Lake WA', id: 'L678901', lat: 43.413, lng: -89.315, county: 'Columbia' },
        { name: 'Mud Lake WA', id: 'L789012', lat: 43.466, lng: -89.359, county: 'Columbia' },
      ];

      const records = [];
      let subId = 100000;

      for (const year of YEARS) {
        const maxDoy = year === 2026 ? 130 : 365;

        for (const sp of MOCK_SPECIES) {
          let startDoy, endDoy;
          if (sp.resident) {
            startDoy = 1;
            endDoy = 365;
          } else if (sp.winter) {
            startDoy = sp.earliest;
            endDoy = sp.latest;
          } else {
            startDoy = sp.earliest || 1;
            endDoy = sp.latest || 365;
          }

          if (Math.random() < 0.15 && !sp.resident) continue;

          const numSightings = sp.resident
            ? Math.floor(Math.random() * 12) + 4
            : Math.floor(Math.random() * 6) + 2;

          for (let s = 0; s < numSightings; s++) {
            let doy;
            if (sp.winter) {
              if (startDoy > endDoy) {
                doy = Math.random() < 0.5
                  ? Math.floor(Math.random() * (365 - startDoy + 1)) + startDoy
                  : Math.floor(Math.random() * endDoy) + 1;
              } else {
                doy = Math.floor(Math.random() * (endDoy - startDoy + 1)) + startDoy;
              }
            } else {
              const adjStart = Math.max(1, startDoy - 7 + Math.floor(Math.random() * 7));
              const adjEnd = Math.min(365, endDoy + Math.floor(Math.random() * 7));
              doy = Math.floor(Math.random() * (adjEnd - adjStart + 1)) + adjStart;
            }

            if (doy > maxDoy) continue;

            const baseDate = new Date(year, 0, 1);
            baseDate.setDate(doy);
            const dateStr = formatDateISO(baseDate);

            const loc = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
            subId++;

            records.push({
              id: 'S' + subId + '::' + sp.common,
              submissionId: 'S' + subId,
              commonName: sp.common,
              scientificName: sp.scientific,
              taxonomicOrder: sp.order,
              count: Math.floor(Math.random() * 8) + 1,
              state: STATE,
              county: loc.county,
              locationId: loc.id,
              location: loc.name,
              latitude: loc.lat,
              longitude: loc.lng,
              date: dateStr,
              time: `${String(6 + Math.floor(Math.random() * 6)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
              year: year,
              dayOfYear: doy,
              protocol: Math.random() > 0.3 ? 'Traveling' : 'Stationary',
              duration: 30 + Math.floor(Math.random() * 120),
              allObs: Math.random() > 0.2,
              breedingCode: '',
              obsDetails: '',
            });
          }
        }
      }

      DOM.importProgressFill.style.width = '50%';
      DOM.importStatus.textContent = `Storing ${records.length.toLocaleString()} mock records...`;
      DOM.loadingText.textContent = 'Storing...';

      DB.putObservations(records).then(() => {
        DOM.importProgressFill.style.width = '100%';
        DOM.importStatus.textContent = 'Mock data generated successfully.';
        hideLoading();
        showToast(`Generated ${records.length.toLocaleString()} mock observations across ${YEARS.length} years!`, 'success');
        initDashboard();
      }).catch(err => {
        hideLoading();
        showToast('Error storing mock data: ' + err.message, 'error');
      });
    }).catch(err => {
      hideLoading();
      showToast('Error clearing old database: ' + err.message, 'error');
    });
  }

  /* -----------------------------------------------------------------------
     9. Dashboard Initialization
     ----------------------------------------------------------------------- */

  async function initDashboard() {
    showLoading('Loading dashboard...');

    try {
      state.regions = await DB.getDistinctRegions();
      populateRegionFilters();

      const targetList = await DB.getTargets();
      state.targets = new Map();
      for (const t of targetList) {
        state.targets.set(t.commonName, t);
      }

      const savedState = await DB.getSetting('filterState');
      const savedCounty = await DB.getSetting('filterCounty');
      if (savedState) { state.filterState = savedState; DOM.filterState.value = savedState; }
      if (savedCounty) { state.filterCounty = savedCounty; DOM.filterCounty.value = savedCounty; }

      const savedAggregate = await DB.getSetting('aggregateSubspecies');
      const savedTrueSpecies = await DB.getSetting('showTrueSpeciesOnly');
      if (savedAggregate !== null) {
        state.aggregateSubspecies = savedAggregate;
        DOM.toggleAggregate.checked = savedAggregate;
      }
      if (savedTrueSpecies !== null) {
        state.showTrueSpeciesOnly = savedTrueSpecies;
        DOM.toggleTrueSpecies.checked = savedTrueSpecies;
      }

      const savedTickLevel = await DB.getSetting('tickLevel');
      if (savedTickLevel && DOM.tickLevel) {
        DOM.tickLevel.value = savedTickLevel;
        if (savedTickLevel === 'state' && DOM.filterCounty) {
          DOM.filterCounty.disabled = true;
          DOM.filterCounty.value = '';
          state.filterCounty = '';
        }
      }

      const savedExportInfographic = await DB.getSetting('toggleExportInfographic');
      if (savedExportInfographic !== null && DOM.toggleExportInfographic) {
        DOM.toggleExportInfographic.checked = savedExportInfographic;
      }

      const savedUserExclusions = await DB.getSetting('userExclusions');
      state.userExclusions = savedUserExclusions || [];

      const savedDisabledSystem = await DB.getSetting('disabledSystemExclusions');
      state.disabledSystemExclusions = savedDisabledSystem || [];

      const totalRecords = await DB.countObservations();
      DOM.statTotalRecords.textContent = totalRecords.toLocaleString();
      state.isDataLoaded = totalRecords > 0;

      if (state.isDataLoaded) {
        await populateSettingsForms();
      }

      if (state.isDataLoaded) {
        const latestDate = await DB.getLatestDate();
        if (latestDate) {
          const parsed = parseRobustDate(latestDate);
          DOM.statDateAsOf.textContent = parsed ? formatDateLabel(parsed) : latestDate;
        } else {
          DOM.statDateAsOf.textContent = '—';
        }
      } else {
        DOM.statDateAsOf.textContent = '—';
      }
      syncViewVisibility();
      if (state.isDataLoaded) {
        await refreshGrid();
      }
    } catch (err) {
      console.error('Dashboard init error:', err);
      showToast('Error loading dashboard: ' + err.message, 'error');
    }

    hideLoading();
  }

  /* -----------------------------------------------------------------------
     10. Region Filter Population
     ----------------------------------------------------------------------- */

  function populateRegionFilters() {
    const states = [...new Set(state.regions.map(r => r.state))].sort();
    DOM.filterState.innerHTML = '<option value="">All States</option>';
    for (const s of states) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === state.filterState) opt.selected = true;
      DOM.filterState.appendChild(opt);
    }
    populateCountyFilter();
    populateYearFilter();
  }

  function populateCountyFilter() {
    const filtered = state.filterState
      ? state.regions.filter(r => r.state === state.filterState)
      : state.regions;
    const counties = [...new Set(filtered.map(r => r.county))].filter(c => c).sort();

    DOM.filterCounty.innerHTML = '<option value="">All Counties</option>';
    for (const c of counties) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === state.filterCounty) opt.selected = true;
      DOM.filterCounty.appendChild(opt);
    }
  }

  function populateYearFilter() {
    const currentYear = new Date().getFullYear();
    DOM.filterYear.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 8; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === state.targetYear) opt.selected = true;
      DOM.filterYear.appendChild(opt);
    }
  }

  /* -----------------------------------------------------------------------
     11. Grid Data Computation
     ----------------------------------------------------------------------- */

  async function refreshGrid() {
    showLoading('Computing species grid...');

    try {
      const filter = {};
      if (state.filterState) filter.state = state.filterState;
      if (state.filterCounty) filter.county = state.filterCounty;

      state.observations = await DB.getObservations(
        (filter.state || filter.county) ? filter : undefined
      );

      computeSpeciesData();
      renderGrid();
      updateStats();
      updateAlerts();

      if (state.activeTab === 'tick') {
        await renderTickExplorer();
      } else if (state.activeTab === 'settings') {
        await renderSettings();
      }
    } catch (err) {
      console.error('Grid refresh error:', err);
      showToast('Error refreshing grid: ' + err.message, 'error');
    }

    hideLoading();
  }

  function computeSpeciesData() {
    const currentYear = state.targetYear;
    const yearsToShow = [];
    for (let y = currentYear; y > currentYear - 5; y--) {
      yearsToShow.push(y);
    }

    const speciesMap = new Map();

    for (const obs of state.observations) {
      if (state.showTrueSpeciesOnly && !isTrueSpecies(obs.commonName, obs.scientificName)) {
        continue;
      }

      // Filter out non-countable exotics/exclusions
      if (isNonCountable(obs.commonName, obs.state, obs.county)) {
        continue;
      }

      let displayName = obs.commonName;
      if (state.aggregateSubspecies) {
        displayName = stripSubspecies(displayName);
      }

      if (!speciesMap.has(displayName)) {
        speciesMap.set(displayName, {
          commonName: displayName,
          scientificName: obs.scientificName,
          taxonomicOrder: obs.taxonomicOrder,
          yearsSeen: new Set(),
          allDaysOfYear: [],
          totalSightings: 0,
        });
      }

      const sp = speciesMap.get(displayName);
      sp.yearsSeen.add(obs.year);
      sp.allDaysOfYear.push(obs.dayOfYear);
      sp.totalSightings++;

      if (obs.taxonomicOrder < sp.taxonomicOrder) {
        sp.taxonomicOrder = obs.taxonomicOrder;
      }
    }

    const simDateDoy = dateToDayOfYear(state.simDate);
    const results = [];

    for (const [name, sp] of speciesMap) {
      const doys = sp.allDaysOfYear;
      let earliestDoy = Infinity;
      let latestDoy = -Infinity;

      if (doys.length > 0) {
        const uniqueDoys = [...new Set(doys)].sort((a, b) => a - b);
        if (uniqueDoys.length === 1) {
          earliestDoy = uniqueDoys[0];
          latestDoy = uniqueDoys[0];
        } else {
          // Find the largest gap between consecutive sightings
          let maxGapSize = 0;
          let maxGapIndex = -1;

          for (let i = 0; i < uniqueDoys.length - 1; i++) {
            const gap = uniqueDoys[i + 1] - uniqueDoys[i];
            if (gap > maxGapSize) {
              maxGapSize = gap;
              maxGapIndex = i;
            }
          }

          // Also check wrap-around gap at the end of the year
          const wrapGap = (365 - uniqueDoys[uniqueDoys.length - 1]) + uniqueDoys[0];

          // A winter wrapping species has its largest gap in the middle of the year (summer)
          // and this gap is substantial (e.g., > 140 days).
          if (maxGapSize > wrapGap && maxGapSize > 140 && maxGapIndex !== -1) {
            // Summer gap: the bird is absent between uniqueDoys[maxGapIndex] and uniqueDoys[maxGapIndex+1]
            // Arrival in fall is the first day after the gap
            earliestDoy = uniqueDoys[maxGapIndex + 1];
            // Departure in spring is the last day before the gap
            latestDoy = uniqueDoys[maxGapIndex];
          } else {
            // Standard contiguous presence
            earliestDoy = uniqueDoys[0];
            latestDoy = uniqueDoys[uniqueDoys.length - 1];
          }
        }
      }

      const yoyChecks = {};
      for (const y of yearsToShow) {
        yoyChecks[y] = sp.yearsSeen.has(y);
      }

      const isTarget = state.targets.has(name);
      const seenInTargetYear = sp.yearsSeen.has(currentYear);

      // Past Due logic with winter species wrapping awareness:
      // If earliestDoy > latestDoy, the species wraps around the year boundary
      // (e.g., Snowy Owl: earliest=310 (Nov), latest=80 (Mar)).
      // For wrapping species, they are "past due" if simDate is in the gap
      // between latestDoy and earliestDoy (the months they are NOT present).
      // For non-wrapping species, past due if simDateDoy > earliestDoy.
      let isPastDue = false;
      if (isTarget && !seenInTargetYear) {
        const isWinterWrapping = earliestDoy > latestDoy;
        if (isWinterWrapping) {
          // Species wraps: present from earliestDoy (fall) through year end and
          // from year start through latestDoy (spring). Past due if we're in the
          // "presence window" but haven't seen it.
          isPastDue = simDateDoy >= earliestDoy || simDateDoy <= latestDoy;
        } else {
          isPastDue = simDateDoy > earliestDoy;
        }
      }

      results.push({
        commonName: name,
        scientificName: sp.scientificName,
        taxonomicOrder: sp.taxonomicOrder,
        earliestDoy,
        latestDoy,
        earliestLabel: dayOfYearToLabel(earliestDoy),
        latestLabel: dayOfYearToLabel(latestDoy),
        yoyChecks,
        isTarget,
        seenInTargetYear,
        isPastDue,
        totalSightings: sp.totalSightings,
        totalYears: sp.yearsSeen.size,
      });
    }

    let filtered = results;

    // Apply year column filters
    for (const [yearStr, filterVal] of Object.entries(state.yearFilters)) {
      const yr = parseInt(yearStr, 10);
      if (filterVal === 'seen') {
        filtered = filtered.filter(sp => sp.yoyChecks[yr] === true);
      } else if (filterVal === 'unseen') {
        filtered = filtered.filter(sp => sp.yoyChecks[yr] === false);
      }
    }

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      filtered = filtered.filter(sp =>
        sp.commonName.toLowerCase().includes(q) ||
        sp.scientificName.toLowerCase().includes(q)
      );
    }

    if (state.targetsOnly) {
      filtered = filtered.filter(sp => sp.isTarget);
    }

    if (state.pastDueOnly) {
      filtered = filtered.filter(sp => sp.isPastDue);
    }

    filtered.sort((a, b) => {
      let valA, valB;
      switch (state.sortColumn) {
        case 'commonName':
          valA = a.commonName.toLowerCase();
          valB = b.commonName.toLowerCase();
          return state.sortDirection === 'asc'
            ? valA.localeCompare(valB)
            : valB.localeCompare(valA);
        case 'earliest':
          valA = a.earliestDoy; valB = b.earliestDoy;
          break;
        case 'latest':
          valA = a.latestDoy; valB = b.latestDoy;
          break;
        case 'totalSightings':
          valA = a.totalSightings; valB = b.totalSightings;
          break;
        case 'taxonomicOrder':
        default:
          valA = a.taxonomicOrder; valB = b.taxonomicOrder;
          break;
      }
      return state.sortDirection === 'asc' ? valA - valB : valB - valA;
    });

    state.speciesData = filtered;
  }

  /* -----------------------------------------------------------------------
     12. Grid Rendering
     ----------------------------------------------------------------------- */

  function renderGrid() {
    const currentYear = state.targetYear;
    const yearsToShow = [];
    for (let y = currentYear; y > currentYear - 5; y--) {
      yearsToShow.push(y);
    }

    const headerCols = [
      { key: 'target', label: '🎯', sortable: false },
      { key: 'commonName', label: 'Species', sortable: true },
      ...yearsToShow.map(y => {
        const filterVal = state.yearFilters[y] || 'all';
        let suffix = '';
        if (filterVal === 'seen') suffix = ' ✅';
        else if (filterVal === 'unseen') suffix = ' ❌';
        return {
          key: 'year-' + y,
          year: y,
          label: String(y) + suffix,
          sortable: false,
          filterable: true,
          filterVal: filterVal
        };
      }),
      { key: 'earliest', label: 'Earliest', sortable: true },
      { key: 'latest', label: 'Latest', sortable: true },
      { key: 'totalSightings', label: 'Count', sortable: true },
      { key: 'status', label: 'Status', sortable: false },
    ];

    DOM.gridHeaderRow.innerHTML = '';
    for (const col of headerCols) {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.dataset.key = col.key;
      if (col.sortable) {
        th.style.cursor = 'pointer';
        if (state.sortColumn === col.key) {
          th.classList.add(state.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
        th.addEventListener('click', () => handleSort(col.key));
      } else if (col.filterable) {
        th.style.cursor = 'pointer';
        th.title = `Click to cycle filter: All / Seen / Not Seen (Currently: ${col.filterVal.toUpperCase()})`;
        th.classList.add('th--year-filter');
        if (col.filterVal !== 'all') {
          th.classList.add(col.filterVal === 'seen' ? 'th--year-filter-seen' : 'th--year-filter-unseen');
        }
        th.addEventListener('click', () => handleYearHeaderClick(col.year));
      }
      DOM.gridHeaderRow.appendChild(th);
    }

    DOM.gridBody.innerHTML = '';

    // Use DocumentFragment for performance
    const fragment = document.createDocumentFragment();

    for (const sp of state.speciesData) {
      const tr = document.createElement('tr');
      if (sp.isPastDue) {
        tr.classList.add('row--past-due');
      } else if (sp.isTarget) {
        tr.classList.add('row--target');
      }

      // Target toggle
      const tdTarget = document.createElement('td');
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'target-toggle' + (sp.isTarget ? ' is-target' : '');
      toggleBtn.textContent = sp.isTarget ? '🎯' : '○';
      toggleBtn.title = sp.isTarget ? 'Remove target' : 'Mark as target';
      toggleBtn.addEventListener('click', () => handleToggleTarget(sp.commonName, !sp.isTarget));
      tdTarget.appendChild(toggleBtn);
      tr.appendChild(tdTarget);

      // Species name
      const tdName = document.createElement('td');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'species-name';
      const commonSpan = document.createElement('span');
      commonSpan.className = 'species-name__common';
      commonSpan.textContent = sp.commonName;
      const sciSpan = document.createElement('span');
      sciSpan.className = 'species-name__scientific';
      sciSpan.textContent = sp.scientificName;
      nameDiv.appendChild(commonSpan);
      nameDiv.appendChild(sciSpan);
      tdName.appendChild(nameDiv);
      tr.appendChild(tdName);

      // Year checks
      for (const y of yearsToShow) {
        const td = document.createElement('td');
        td.className = 'year-check';
        if (sp.yoyChecks[y]) {
          td.classList.add('year-check--seen');
          td.textContent = '✓';
          td.title = `Seen in ${y}`;
        } else {
          td.classList.add('year-check--unseen');
          td.textContent = '—';
          td.title = `Not seen in ${y}`;
        }
        tr.appendChild(td);
      }

      // Earliest
      const tdEarliest = document.createElement('td');
      tdEarliest.className = 'date-cell';
      tdEarliest.textContent = sp.earliestLabel;
      tr.appendChild(tdEarliest);

      // Latest
      const tdLatest = document.createElement('td');
      tdLatest.className = 'date-cell';
      tdLatest.textContent = sp.latestLabel;
      tr.appendChild(tdLatest);

      // Count
      const tdCount = document.createElement('td');
      tdCount.className = 'date-cell';
      tdCount.textContent = sp.totalSightings.toLocaleString();
      tr.appendChild(tdCount);

      // Status
      const tdStatus = document.createElement('td');
      if (sp.isPastDue) {
        const badge = document.createElement('span');
        badge.className = 'past-due-badge';
        badge.textContent = '⚠️ Past Due';
        tdStatus.appendChild(badge);
      } else if (sp.isTarget && sp.seenInTargetYear) {
        const found = document.createElement('span');
        found.style.cssText = 'color: var(--color-success); font-size: var(--font-size-xs); font-weight: 600;';
        found.textContent = '✓ Found';
        tdStatus.appendChild(found);
      } else if (sp.isTarget) {
        const tracking = document.createElement('span');
        tracking.style.cssText = 'color: var(--color-info); font-size: var(--font-size-xs); font-weight: 500;';
        tracking.textContent = 'Tracking';
        tdStatus.appendChild(tracking);
      }
      tr.appendChild(tdStatus);

      fragment.appendChild(tr);
    }

    DOM.gridBody.appendChild(fragment);

    DOM.statTotalSpecies.textContent = state.speciesData.length.toLocaleString();
  }

  /* -----------------------------------------------------------------------
     13. Stats & Alerts
     ----------------------------------------------------------------------- */

  function updateStats() {
    const total = state.speciesData.length;
    const targets = state.speciesData.filter(sp => sp.isTarget).length;
    const pastDue = state.speciesData.filter(sp => sp.isPastDue).length;

    DOM.statBarSpecies.textContent = total;
    DOM.statBarTargets.textContent = targets;
    DOM.statBarPastDue.textContent = pastDue;
    DOM.statBarYear.textContent = state.targetYear;
    DOM.statBarSimDate.textContent = formatDateLabel(state.simDate);
  }

  function updateAlerts() {
    const pastDueSpecies = state.speciesData.filter(sp => sp.isPastDue);

    if (pastDueSpecies.length > 0) {
      DOM.alertsPanel.classList.add('is-open');
      DOM.alertsList.innerHTML = '';
      const fragment = document.createDocumentFragment();
      for (const sp of pastDueSpecies) {
        const li = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = 'alert-tag';
        tag.textContent = `⚠️ ${sp.commonName} (since ${sp.earliestLabel})`;
        li.appendChild(tag);
        fragment.appendChild(li);
      }
      DOM.alertsList.appendChild(fragment);
    } else {
      DOM.alertsPanel.classList.remove('is-open');
    }
  }

  /* -----------------------------------------------------------------------
     13.5. Tick Explorer Engine
     ----------------------------------------------------------------------- */

  function syncViewVisibility() {
    if (!state.isDataLoaded) {
      DOM.emptyState.style.display = 'flex';
      DOM.gridWrapper.style.display = 'none';
      DOM.statsBar.style.display = 'none';
      DOM.tickExplorerWrapper.style.display = 'none';
      DOM.settingsWrapper.style.display = 'none';
      DOM.tabYoY.style.display = 'none';
      DOM.tabTick.style.display = 'none';
      DOM.tabSettings.style.display = 'none';
      return;
    }

    DOM.emptyState.style.display = 'none';
    DOM.tabYoY.style.display = 'flex';
    DOM.tabTick.style.display = 'flex';
    DOM.tabSettings.style.display = 'flex';

    if (state.activeTab === 'yoy') {
      DOM.gridWrapper.style.display = 'block';
      DOM.statsBar.style.display = 'flex';
      DOM.tickExplorerWrapper.style.display = 'none';
      DOM.settingsWrapper.style.display = 'none';
      DOM.tabYoY.classList.add('is-active');
      DOM.tabTick.classList.remove('is-active');
      DOM.tabSettings.classList.remove('is-active');
    } else if (state.activeTab === 'tick') {
      DOM.gridWrapper.style.display = 'none';
      DOM.statsBar.style.display = 'none';
      DOM.tickExplorerWrapper.style.display = 'flex';
      DOM.settingsWrapper.style.display = 'none';
      DOM.tabYoY.classList.remove('is-active');
      DOM.tabTick.classList.add('is-active');
      DOM.tabSettings.classList.remove('is-active');
    } else if (state.activeTab === 'settings') {
      DOM.gridWrapper.style.display = 'none';
      DOM.statsBar.style.display = 'none';
      DOM.tickExplorerWrapper.style.display = 'none';
      DOM.settingsWrapper.style.display = 'flex';
      DOM.tabYoY.classList.remove('is-active');
      DOM.tabTick.classList.remove('is-active');
      DOM.tabSettings.classList.add('is-active');
    }
  }

  async function switchTab(tab) {
    if (state.activeTab === tab) return;
    state.activeTab = tab;
    syncViewVisibility();

    if (state.activeTab === 'tick') {
      await renderTickExplorer();
    } else if (state.activeTab === 'settings') {
      await renderSettings();
    }
  }

  function computeTickMilestones() {
    const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';
    const milestonesMap = new Map(); // "state::county::commonName" or "state::commonName" -> earliest observation
    const hotspots = new Map(); // "state::county" or "state" -> [{lat, lng}]

    for (const obs of state.observations) {
      if (!obs.state || !obs.commonName) continue;
      if (!isStateLevel && !obs.county) continue;

      // Filter non-true species if that toggle is active
      if (state.showTrueSpeciesOnly && !isTrueSpecies(obs.commonName, obs.scientificName)) {
        continue;
      }

      // Filter out non-countable exotics/exclusions
      if (isNonCountable(obs.commonName, obs.state, isStateLevel ? '' : obs.county)) {
        continue;
      }

      let name = obs.commonName;
      if (state.aggregateSubspecies) {
        name = stripSubspecies(name);
      }

      const key = isStateLevel ? `${obs.state}::${name}` : `${obs.state}::${obs.county}::${name}`;
      const existing = milestonesMap.get(key);

      if (!existing || obs.date < existing.date) {
        milestonesMap.set(key, {
          date: obs.date,
          commonName: name,
          scientificName: obs.scientificName,
          state: obs.state,
          county: isStateLevel ? '' : obs.county,
          lat: obs.latitude,
          lng: obs.longitude
        });
      }

      // Collect GPS coordinates for centroid calculation
      if (obs.latitude !== 0 && obs.longitude !== 0) {
        const cKey = isStateLevel ? obs.state : `${obs.state}::${obs.county}`;
        if (!hotspots.has(cKey)) {
          hotspots.set(cKey, []);
        }
        hotspots.get(cKey).push({ lat: obs.latitude, lng: obs.longitude });
      }
    }

    // Sort milestones chronologically
    state.tickMilestones = Array.from(milestonesMap.values());
    state.tickMilestones.sort((a, b) => a.date.localeCompare(b.date));

    // Calculate centroids
    const centroids = new Map();
    for (const [cKey, coords] of hotspots) {
      const sum = coords.reduce((acc, c) => ({ lat: acc.lat + c.lat, lng: acc.lng + c.lng }), { lat: 0, lng: 0 });
      centroids.set(cKey, {
        lat: sum.lat / coords.length,
        lng: sum.lng / coords.length
      });
    }

    return centroids;
  }

  function getEbirdRegionCode() {
    if (!state.filterState) {
      return 'US';
    }
    const cleanState = cleanStateCode(state.filterState);
    if (!state.selectedMapCounty) {
      return `US-${cleanState}`;
    }

    const stateFips = STATE_TO_FIPS[cleanState];
    if (stateFips && typeof topojson !== 'undefined' && window.US_ATLAS) {
      try {
        const counties = topojson.feature(window.US_ATLAS, window.US_ATLAS.objects.counties).features;
        const countyFeature = counties.find(
          f => f.id.startsWith(stateFips) && 
               f.properties.name.toLowerCase() === state.selectedMapCounty.toLowerCase()
        );
        if (countyFeature) {
          const countyFipsSuffix = countyFeature.id.slice(2);
          return `US-${cleanState}-${countyFipsSuffix}`;
        }
      } catch (err) {
        console.error('Error mapping county to eBird region code:', err);
      }
    }

    return `US-${cleanState}`;
  }

  async function renderTickExplorer() {
    showLoading('Rendering Tick Explorer...');

    try {
      const centroids = computeTickMilestones();

      // Update eBird helper link
      if (DOM.btnEbirdLifelist) {
        const regionCode = getEbirdRegionCode();
        DOM.btnEbirdLifelist.href = `https://ebird.org/lifelist?r=${regionCode}&time=life&fmt=csv`;
        
        let label = 'US';
        if (state.filterState) {
          const cleanState = cleanStateCode(state.filterState);
          label = cleanState;
          if (state.selectedMapCounty) {
            label = `${state.selectedMapCounty}, ${cleanState}`;
          }
        }
        DOM.btnEbirdLifelist.textContent = `🔗 Download ${label} Life List`;
      }

      // Aggregate list sizes by subregions
      const subregions = new Map(); // "state::county" or "state" -> { county, state, lat, lng, speciesCount, speciesSet }
      const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';

      for (const m of state.tickMilestones) {
        const cKey = isStateLevel ? m.state : `${m.state}::${m.county}`;
        if (!subregions.has(cKey)) {
          const centroid = centroids.get(cKey) || { lat: m.lat, lng: m.lng };
          subregions.set(cKey, {
            county: isStateLevel ? '' : m.county,
            state: m.state,
            lat: centroid.lat,
            lng: centroid.lng,
            speciesCount: 0,
            speciesSet: new Set()
          });
        }

        const sub = subregions.get(cKey);
        if (!sub.speciesSet.has(m.commonName)) {
          sub.speciesSet.add(m.commonName);
          sub.speciesCount++;
        }
      }

      // Find top region
      let topRegionName = 'None';
      let topRegionCount = 0;
      let maxSpeciesCount = 0;
      
      for (const [_, sub] of subregions) {
        if (sub.speciesCount > maxSpeciesCount) {
          maxSpeciesCount = sub.speciesCount;
          topRegionName = isStateLevel ? cleanStateCode(sub.state) : sub.county;
          topRegionCount = sub.speciesCount;
        }
      }

      // Update Summary Cards
      if (DOM.tickStatTotalLabel) {
        DOM.tickStatTotalLabel.textContent = isStateLevel ? '🌍 Total State Ticks' : '🗺️ Total County Ticks';
      }
      if (DOM.tickStatCountiesLabel) {
        DOM.tickStatCountiesLabel.textContent = isStateLevel ? '📍 States Visited' : '📍 Counties Visited';
      }
      if (DOM.tickStatTopLabel) {
        DOM.tickStatTopLabel.textContent = isStateLevel ? '🏆 Top State' : '🏆 Top County';
      }

      DOM.tickStatTotal.textContent = state.tickMilestones.length.toLocaleString();
      DOM.tickStatCounties.textContent = subregions.size.toLocaleString();
      DOM.tickStatTop.textContent = topRegionName;
      DOM.tickStatTopCount.textContent = `${topRegionCount.toLocaleString()} species`;

      if (isStateLevel) {
        if (DOM.tickStatTotalDesc) DOM.tickStatTotalDesc.textContent = 'Across all states';
        if (DOM.tickStatCountiesDesc) DOM.tickStatCountiesDesc.textContent = 'Unique states logged';
      } else {
        if (DOM.tickStatTotalDesc) DOM.tickStatTotalDesc.textContent = 'Across all subregions';
        if (DOM.tickStatCountiesDesc) DOM.tickStatCountiesDesc.textContent = 'Unique counties logged';
      }

      // Dynamic Map Color Mode Validation
      const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);
      if (DOM.mapColorMode) {
        const addedOption = DOM.mapColorMode.options[1]; // Timeframe Additions
        if (addedOption) {
          if (!isTimeframeActive) {
            addedOption.disabled = true;
            if (DOM.mapColorMode.value === 'added') {
              DOM.mapColorMode.value = 'total';
            }
          } else {
            addedOption.disabled = false;
          }
        }
      }

      // Filter milestones for chart & analyzer if county is focused
      const activeMilestones = state.selectedMapCounty
        ? state.tickMilestones.filter(m => m.county === state.selectedMapCounty)
        : state.tickMilestones;

      // Render components
      renderSubregionsList(subregions);
      renderTickMap(subregions, maxSpeciesCount);
      renderTickChart(activeMilestones);
      renderTimeframeAdditions();

      // Update analyzer summary badge
      if (isTimeframeActive && DOM.analyzerSummary) {
        const startTotal = state.tickDateStart
          ? activeMilestones.filter(m => m.date < state.tickDateStart).length
          : 0;
        const endTotal = state.tickDateEnd
          ? activeMilestones.filter(m => m.date <= state.tickDateEnd).length
          : activeMilestones.length;
        const addedTotal = activeMilestones.filter(m => {
          if (state.tickDateStart && m.date < state.tickDateStart) return false;
          if (state.tickDateEnd && m.date > state.tickDateEnd) return false;
          return true;
        }).length;

        if (DOM.analyzerStart) DOM.analyzerStart.textContent = `Start: ${startTotal.toLocaleString()} Ticks`;
        if (DOM.analyzerEnd) DOM.analyzerEnd.textContent = `End: ${endTotal.toLocaleString()} Ticks`;
        if (DOM.analyzerAdded) DOM.analyzerAdded.textContent = `+${addedTotal.toLocaleString()} Ticks Gained`;

        DOM.analyzerSummary.style.display = 'flex';
      } else if (DOM.analyzerSummary) {
        DOM.analyzerSummary.style.display = 'none';
      }

    } catch (err) {
      console.error('Tick Explorer render error:', err);
      showToast('Error rendering Tick Explorer: ' + err.message, 'error');
    }

    hideLoading();
  }

  function renderSubregionsList(subregionsMap) {
    const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';

    // Update table headers dynamically with sort indicators and styling
    const tableEl = DOM.subregionListBody.closest('table');
    if (tableEl) {
      const ths = tableEl.querySelectorAll('thead th');
      const sortCols = ['name', 'state', 'speciesCount', 'startTotal', 'endTotal', 'added'];
      
      ths.forEach((th, idx) => {
        const colType = sortCols[idx];
        let baseText = '';
        if (idx === 0) baseText = isStateLevel ? 'State' : 'County';
        else if (idx === 1) baseText = isStateLevel ? 'Country' : 'State';
        else if (idx === 2) baseText = 'Total Ticks';
        else if (idx === 3) baseText = 'Timeframe Start';
        else if (idx === 4) baseText = 'Timeframe End';
        else if (idx === 5) baseText = 'Added';

        // Add sort indicator icon
        let icon = '';
        if (state.tickSortColumn === colType) {
          icon = state.tickSortDirection === 'asc' ? ' ▲' : ' ▼';
        }
        th.textContent = baseText + icon;
        th.style.cursor = 'pointer';
        th.style.userSelect = 'none';
        th.setAttribute('data-sort', colType);
      });
    }

    if (!subregionsMap) {
      const centroids = computeTickMilestones();
      subregionsMap = new Map();
      for (const m of state.tickMilestones) {
        const cKey = isStateLevel ? m.state : `${m.state}::${m.county}`;
        if (!subregionsMap.has(cKey)) {
          const centroid = centroids.get(cKey) || { lat: m.lat, lng: m.lng };
          subregionsMap.set(cKey, {
            county: isStateLevel ? '' : m.county,
            state: m.state,
            lat: centroid.lat,
            lng: centroid.lng,
            speciesCount: 0,
            speciesSet: new Set()
          });
        }
        const sub = subregionsMap.get(cKey);
        if (!sub.speciesSet.has(m.commonName)) {
          sub.speciesSet.add(m.commonName);
          sub.speciesCount++;
        }
      }
    }

    // Compute timeframe additions count for each subregion
    const addedCounts = new Map();
    // Compute "end total" = species count at end of timeframe (ticks on or before end date)
    const endTotalCounts = new Map();
    // Compute "start total" = species count at start of timeframe (ticks strictly before start date)
    const startTotalCounts = new Map();
    for (const m of state.tickMilestones) {
      const cKey = isStateLevel ? m.state : `${m.state}::${m.county}`;
      if (!addedCounts.has(cKey)) {
        addedCounts.set(cKey, 0);
      }
      if (!endTotalCounts.has(cKey)) {
        endTotalCounts.set(cKey, new Set());
      }
      if (!startTotalCounts.has(cKey)) {
        startTotalCounts.set(cKey, new Set());
      }
      
      let isWithin = true;
      if (state.tickDateStart && m.date < state.tickDateStart) isWithin = false;
      if (state.tickDateEnd && m.date > state.tickDateEnd) isWithin = false;
      
      if (isWithin) {
        addedCounts.set(cKey, addedCounts.get(cKey) + 1);
      }

      // Count species on or before end date
      if (!state.tickDateEnd || m.date <= state.tickDateEnd) {
        endTotalCounts.get(cKey).add(m.commonName);
      }

      // Count species strictly before start date
      if (state.tickDateStart && m.date < state.tickDateStart) {
        startTotalCounts.get(cKey).add(m.commonName);
      }
    }

    DOM.subregionListBody.innerHTML = '';
    const items = Array.from(subregionsMap.values());

    let filtered = items;
    if (state.tickSearchQuery) {
      filtered = items.filter(
        item => {
          const countyMatch = item.county ? item.county.toLowerCase().includes(state.tickSearchQuery) : false;
          const stateMatch = item.state ? item.state.toLowerCase().includes(state.tickSearchQuery) : false;
          return countyMatch || stateMatch;
        }
      );
    }

    // Map items to enrich them with computed metrics for sorting
    const itemsWithMetrics = filtered.map(item => {
      const cKey = isStateLevel ? item.state : `${item.state}::${item.county}`;
      const added = addedCounts.get(cKey) || 0;
      const endTotalSet = endTotalCounts.get(cKey);
      const endTotal = endTotalSet ? endTotalSet.size : item.speciesCount;
      const startTotalSet = startTotalCounts.get(cKey);
      const startTotal = startTotalSet ? startTotalSet.size : 0;
      const name = isStateLevel ? cleanStateCode(item.state) : item.county;

      return {
        item,
        name,
        added,
        endTotal,
        startTotal
      };
    });

    // Sort enriched items dynamically based on selected column
    const col = state.tickSortColumn || 'speciesCount';
    const dir = state.tickSortDirection || 'desc';

    itemsWithMetrics.sort((a, b) => {
      let valA, valB;
      if (col === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (col === 'state') {
        valA = isStateLevel ? 'US' : cleanStateCode(a.item.state).toLowerCase();
        valB = isStateLevel ? 'US' : cleanStateCode(b.item.state).toLowerCase();
      } else if (col === 'speciesCount') {
        valA = a.item.speciesCount;
        valB = b.item.speciesCount;
      } else if (col === 'startTotal') {
        valA = a.startTotal;
        valB = b.startTotal;
      } else if (col === 'endTotal') {
        valA = a.endTotal;
        valB = b.endTotal;
      } else if (col === 'added') {
        valA = a.added;
        valB = b.added;
      }

      if (valA < valB) return dir === 'asc' ? -1 : 1;
      if (valA > valB) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);
    const fragment = document.createDocumentFragment();
    for (const enriched of itemsWithMetrics) {
      const { item, name: cleanName, added: addedCount, endTotal, startTotal } = enriched;
      const tr = document.createElement('tr');
      if (!isStateLevel && state.selectedMapCounty === item.county) {
        tr.classList.add('is-selected');
      }

      const tdCounty = document.createElement('td');
      tdCounty.textContent = isStateLevel ? cleanStateCode(item.state) : item.county;
      tdCounty.style.fontWeight = '500';
      tr.appendChild(tdCounty);

      const tdState = document.createElement('td');
      tdState.textContent = isStateLevel ? 'US' : cleanStateCode(item.state);
      tr.appendChild(tdState);

      const tdTicks = document.createElement('td');
      tdTicks.className = 'date-cell';
      tdTicks.style.textAlign = 'right';
      tdTicks.style.fontWeight = 'bold';
      tdTicks.style.color = 'var(--color-accent)';
      tdTicks.textContent = item.speciesCount.toLocaleString();
      tr.appendChild(tdTicks);

      // Timeframe Start column
      const tdStartTotal = document.createElement('td');
      tdStartTotal.className = 'date-cell';
      tdStartTotal.style.textAlign = 'right';
      tdStartTotal.style.fontWeight = 'bold';
      if (isTimeframeActive) {
        tdStartTotal.textContent = startTotal.toLocaleString();
        tdStartTotal.style.color = '#60a5fa'; // Blue accent
      } else {
        tdStartTotal.textContent = '—';
        tdStartTotal.style.color = 'var(--color-text-tertiary)';
      }
      tr.appendChild(tdStartTotal);

      // Timeframe End column
      const tdEndTotal = document.createElement('td');
      tdEndTotal.className = 'date-cell';
      tdEndTotal.style.textAlign = 'right';
      tdEndTotal.style.fontWeight = 'bold';
      if (isTimeframeActive) {
        tdEndTotal.textContent = endTotal.toLocaleString();
        tdEndTotal.style.color = '#a78bfa'; // Purple accent
      } else {
        tdEndTotal.textContent = '—';
        tdEndTotal.style.color = 'var(--color-text-tertiary)';
      }
      tr.appendChild(tdEndTotal);

      const tdAdded = document.createElement('td');
      tdAdded.className = 'date-cell';
      tdAdded.style.textAlign = 'right';
      tdAdded.style.fontWeight = 'bold';
      if (isTimeframeActive && addedCount > 0) {
        tdAdded.textContent = `+${addedCount}`;
        tdAdded.style.color = '#14b8a6'; // Teal accent
      } else {
        tdAdded.textContent = '—';
        tdAdded.style.color = 'var(--color-text-tertiary)';
      }
      tr.appendChild(tdAdded);

      tr.addEventListener('click', () => {
        if (isStateLevel) {
          DOM.filterState.value = item.state;
          DOM.filterState.dispatchEvent(new Event('change'));
        } else {
          handleMapNodeClick(item.county);
        }
      });

      fragment.appendChild(tr);
    }

    DOM.subregionListBody.appendChild(fragment);
  }

  const FIPS_TO_STATE = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
    "08": "CO", "09": "CT", "10": "DE", "12": "FL", "13": "GA",
    "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
    "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
    "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO",
    "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ",
    "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC",
    "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT",
    "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY"
  };

  const STATE_TO_FIPS = {};
  for (const [fips, code] of Object.entries(FIPS_TO_STATE)) {
    STATE_TO_FIPS[code] = fips;
  }

  function cleanStateCode(code) {
    if (!code) return '';
    return code.includes('-') ? code.split('-')[1] : code;
  }

  function getPolygonCentroid(feature) {
    const geom = feature.geometry;
    if (!geom) return null;
    let sumX = 0, sumY = 0, count = 0;
    
    function processRing(ring) {
      for (const pt of ring) {
        sumX += pt[0];
        sumY += pt[1];
        count++;
      }
    }
    
    if (geom.type === 'Polygon') {
      processRing(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      let maxLen = 0, bestRing = null;
      for (const poly of geom.coordinates) {
        if (poly[0] && poly[0].length > maxLen) {
          maxLen = poly[0].length;
          bestRing = poly[0];
        }
      }
      if (bestRing) processRing(bestRing);
    }
    
    return count > 0 ? [sumX / count, sumY / count] : null;
  }

  function getFeatureVisualCenter(feature) {
    const geom = feature.geometry;
    if (!geom) return null;

    let polygons = [];
    if (geom.type === 'Polygon') {
      polygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      let maxArea = 0;
      let bestPoly = null;
      for (const poly of geom.coordinates) {
        if (poly[0]) {
          const area = getPolygonArea(poly[0]);
          if (area > maxArea) {
            maxArea = area;
            bestPoly = poly;
          }
        }
      }
      if (bestPoly) {
        polygons.push(bestPoly);
      } else {
        polygons.push(geom.coordinates[0]);
      }
    }

    if (polygons.length === 0 || !polygons[0] || !polygons[0][0]) return null;

    return polylabel(polygons[0]);

    function getPolygonArea(ring) {
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p1 = ring[i];
        const p2 = ring[j];
        area += (p2[0] + p1[0]) * (p2[1] - p1[1]);
      }
      return Math.abs(area / 2);
    }

    function polylabel(polygon, precision = 0.5) {
      const outerRing = polygon[0];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const pt of outerRing) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }

      const width = maxX - minX;
      const height = maxY - minY;
      const cellSize = Math.min(width, height);
      const h = cellSize / 2;

      if (cellSize === 0) return [minX, minY];

      const cells = [];

      function createCell(x, y, h) {
        const d = pointToPolygonDistance(x, y, polygon);
        return {
          x, y, h, d,
          max: d + h * Math.SQRT2
        };
      }

      // Helper to do sorted insertion
      function insertSorted(arr, item) {
        let low = 0;
        let high = arr.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (arr[mid].max > item.max) {
            low = mid + 1;
          } else {
            high = mid;
          }
        }
        arr.splice(low, 0, item);
      }

      // Seed cell with bounding box center
      let bestCell = createCell(minX + width / 2, minY + height / 2, 0);

      // Seed cell with simple average centroid of outer ring
      let sumX = 0, sumY = 0;
      for (const pt of outerRing) {
        sumX += pt[0];
        sumY += pt[1];
      }
      const cX = outerRing.length > 0 ? sumX / outerRing.length : minX;
      const cY = outerRing.length > 0 ? sumY / outerRing.length : minY;
      const centroidCell = createCell(cX, cY, 0);
      if (centroidCell.d > bestCell.d) {
        bestCell = centroidCell;
      }

      // Create initial grid of cells
      for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) {
          const cell = createCell(x + h, y + h, h);
          cells.push(cell);
        }
      }

      cells.sort((a, b) => b.max - a.max);

      let iterations = 0;
      while (cells.length > 0 && iterations < 300) {
        iterations++;
        const cell = cells.shift();

        if (cell.d > bestCell.d) {
          bestCell = cell;
        }

        if (cell.max - bestCell.d <= precision) continue;

        const newH = cell.h / 2;
        const q1 = createCell(cell.x - newH, cell.y - newH, newH);
        const q2 = createCell(cell.x + newH, cell.y - newH, newH);
        const q3 = createCell(cell.x - newH, cell.y + newH, newH);
        const q4 = createCell(cell.x + newH, cell.y + newH, newH);

        if (q1.max > bestCell.d) insertSorted(cells, q1);
        if (q2.max > bestCell.d) insertSorted(cells, q2);
        if (q3.max > bestCell.d) insertSorted(cells, q3);
        if (q4.max > bestCell.d) insertSorted(cells, q4);
      }

      return [bestCell.x, bestCell.y];
    }

    function pointToPolygonDistance(x, y, polygon) {
      let inside = false;
      let minDist = Infinity;

      for (let r = 0; r < polygon.length; r++) {
        const ring = polygon[r];

        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const p1 = ring[i];
          const p2 = ring[j];

          if (((p1[1] > y) !== (p2[1] > y)) &&
              (x < (p2[0] - p1[0]) * (y - p1[1]) / (p2[1] - p1[1]) + p1[0])) {
            inside = !inside;
          }

          const dist = pointToSegmentDistanceSquared(x, y, p1, p2);
          if (dist < minDist) {
            minDist = dist;
          }
        }
      }

      minDist = Math.sqrt(minDist);
      return (inside ? 1 : -1) * minDist;
    }

    function pointToSegmentDistanceSquared(x, y, p1, p2) {
      let dx = p2[0] - p1[0];
      let dy = p2[1] - p1[1];

      if (dx === 0 && dy === 0) {
        return (x - p1[0]) * (x - p1[0]) + (y - p1[1]) * (y - p1[1]);
      }

      let t = ((x - p1[0]) * dx + (y - p1[1]) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));

      const px = p1[0] + t * dx;
      const py = p1[1] + t * dy;

      return (x - px) * (x - px) + (y - py) * (y - py);
    }
  }

  function getFeaturePath(feature, minX, maxX, minY, maxY, scale, offsetX, offsetY, isPreProjected) {
    const geom = feature.geometry;
    if (!geom) return '';

    function projectPoint(pt) {
      const ptX = pt[0];
      const ptY = pt[1];
      let x, y;
      if (isPreProjected) {
        x = offsetX + (ptX - minX) * scale;
        y = offsetY + (ptY - minY) * scale;
      } else {
        x = offsetX + (ptX - minX) * scale;
        y = offsetY + (maxY - ptY) * scale;
      }
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }

    function getPolygonPath(polyCoords) {
      let path = '';
      for (const ring of polyCoords) {
        if (ring.length === 0) continue;
        let ringPath = 'M' + projectPoint(ring[0]);
        for (let i = 1; i < ring.length; i++) {
          ringPath += 'L' + projectPoint(ring[i]);
        }
        ringPath += 'Z';
        path += ' ' + ringPath;
      }
      return path.trim();
    }

    if (geom.type === 'Polygon') {
      return getPolygonPath(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      return geom.coordinates.map(getPolygonPath).join(' ');
    }
    return '';
  }

  function renderVectorMap(features, keyField, subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, isPreProjected, endTotalCounts) {
    DOM.mapNodesLayer.innerHTML = '';
    DOM.mapEdgesLayer.innerHTML = '';
    DOM.mapLabelsLayer.innerHTML = '';

    if (features.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    function updateBounds(x, y) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    let boundsFeatures = features;
    if (keyField === 'county' && state.selectedMapCounty) {
      const selectedFeature = features.find(f => f.properties.name === state.selectedMapCounty);
      if (selectedFeature) {
        boundsFeatures = [selectedFeature];
      }
    }

    for (const feature of boundsFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        for (const ring of geom.coordinates) {
          for (const pt of ring) {
            updateBounds(pt[0], pt[1]);
          }
        }
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            for (const pt of ring) {
              updateBounds(pt[0], pt[1]);
            }
          }
        }
      }
    }

    let w = maxX - minX;
    let h = maxY - minY;
    if (w === 0 || h === 0) return;

    // Apply 30% margin compromise if county focus is active
    if (keyField === 'county' && state.selectedMapCounty) {
      const cx = minX + w / 2;
      const cy = minY + h / 2;
      w = w * 1.30;
      h = h * 1.30;
      minX = cx - w / 2;
      maxX = cx + w / 2;
      minY = cy - h / 2;
      maxY = cy + h / 2;
    }

    const width = 500;
    const height = 400;
    const padding = 10;

    const scale = Math.min((width - 2 * padding) / w, (height - 2 * padding) / h);
    const offsetX = (width - w * scale) / 2;
    const offsetY = (height - h * scale) / 2;

    // Update legend values
    if (DOM.mapLegendMin && DOM.mapLegendMax) {
      DOM.mapLegendMin.textContent = '0';
      DOM.mapLegendMax.textContent = activeMax > 0 ? activeMax.toString() : 'Max';
    }

    const fragmentPaths = document.createDocumentFragment();
    const fragmentLabels = document.createDocumentFragment();
    const placedLabels = [];

    for (const feature of features) {
      const pathStr = getFeaturePath(feature, minX, maxX, minY, maxY, scale, offsetX, offsetY, isPreProjected);
      if (!pathStr) continue;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathStr);
      path.setAttribute('stroke-linejoin', 'round');

      let name = feature.properties.name || '';
      let isSelected = false;
      let totalCount = 0;
      let addedCount = 0;
      let stateCode = '';
      let lookupKey = '';

      if (keyField === 'state') {
        const fips = feature.id;
        const code = FIPS_TO_STATE[fips] || '';
        stateCode = code ? `US-${code}` : '';
        lookupKey = stateCode;
        
        for (const [key, sub] of subregionsMap) {
          if (key === stateCode || key.endsWith(code)) {
            totalCount = sub.speciesCount;
            addedCount = addedCounts.get(key) || 0;
            break;
          }
        }
      } else {
        const sCode = state.filterState || 'US-WI';
        lookupKey = `${sCode}::${name}`;
        const sub = subregionsMap.get(lookupKey);
        if (sub) {
          totalCount = sub.speciesCount;
        }
        addedCount = addedCounts.get(lookupKey) || 0;
        isSelected = (state.selectedMapCounty === name);
      }

      // Determine active value based on colorMode
      const activeValue = colorMode === 'added' ? addedCount : totalCount;

      const isLevel3 = (keyField === 'county' && state.selectedMapCounty);

      // Heatmap coloring: Standard yellow-to-red eBird scale
      let fill = 'rgba(255, 255, 255, 0.09)';
      let stroke = isLevel3 ? '#334155' : 'rgba(255, 255, 255, 0.22)';
      let strokeWidth = isLevel3 ? '1px' : '0.7px';

      if (activeValue > 0) {
        const ratio = activeMax > 0 ? activeValue / activeMax : 0;
        const hue = 55 - 55 * ratio;
        const saturation = 100;
        const lightness = 65 - 17 * ratio;
        fill = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        stroke = isLevel3 ? '#475569' : 'rgba(255, 255, 255, 0.32)';
        strokeWidth = isLevel3 ? '1.2px' : '0.8px';
      }

      if (isSelected) {
        path.setAttribute('class', 'county-node-outer is-selected');
        stroke = 'var(--color-accent)';
        strokeWidth = '2px';
      } else {
        path.setAttribute('class', 'county-path-shape');
      }

      path.setAttribute('fill', fill);
      path.setAttribute('stroke', stroke);
      path.setAttribute('stroke-width', strokeWidth);
      path.style.transition = 'fill 0.2s ease, stroke 0.2s ease, stroke-width 0.2s ease';

      path.addEventListener('mouseenter', (e) => {
        path.setAttribute('stroke-width', '2.5px');
        path.setAttribute('stroke', 'var(--color-accent)');
        
        const displayState = keyField === 'state' ? name : (state.filterState || 'Wisconsin');
        const displayName = keyField === 'state' ? name : `${name} County`;
        
        showMapTooltip({ 
          county: displayName, 
          state: displayState, 
          speciesCount: totalCount,
          addedCount: addedCount,
          isTimeframeActive: isTimeframeActive
        }, e);
      });

      path.addEventListener('mouseleave', () => {
        path.setAttribute('stroke-width', strokeWidth);
        path.setAttribute('stroke', stroke);
        hideMapTooltip();
      });

      path.addEventListener('mousemove', positionMapTooltip);
      path.style.cursor = 'pointer';
      
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        if (keyField === 'state') {
          const code = FIPS_TO_STATE[feature.id] || '';
          if (code) {
            const fullCode = `US-${code}`;
            DOM.filterState.value = fullCode;
            DOM.filterState.dispatchEvent(new Event('change'));
          }
        } else {
          handleMapNodeClick(name);
        }
      });

      fragmentPaths.appendChild(path);

      // Label text: endTotal and addition ticks
      let labelText = '';
      let endTotal = totalCount;
      if (endTotalCounts) {
        if (keyField === 'state') {
          // Aggregate endTotal across all counties in this state
          let stateEndTotal = 0;
          const code = FIPS_TO_STATE[feature.id] || '';
          for (const [key, set] of endTotalCounts) {
            if (key.startsWith(`US-${code}::`) || key.startsWith(`${code}::`)) {
              stateEndTotal += set.size;
            }
          }
          if (stateEndTotal > 0) endTotal = stateEndTotal;
        } else {
          const endTotalSet = endTotalCounts.get(lookupKey);
          if (endTotalSet) endTotal = endTotalSet.size;
        }
      }
      if (activeValue > 0) {
        if (colorMode === 'total') {
          if (isTimeframeActive) {
            labelText = endTotal.toString();
            if (addedCount > 0) {
              labelText += ` (+${addedCount})`;
            }
          } else {
            labelText = totalCount.toString();
          }
        } else {
          labelText = addedCount > 0 ? `+${addedCount}` : '';
        }
      }

      if (labelText) {
        const cacheKey = feature.id || lookupKey;
        let visualCenter = state.visualCentroids.get(cacheKey);
        if (!visualCenter) {
          visualCenter = getFeatureVisualCenter(feature);
          if (visualCenter) state.visualCentroids.set(cacheKey, visualCenter);
        }
        const pt = visualCenter || getPolygonCentroid(feature);
        if (pt) {
          const ptX = pt[0];
          const ptY = pt[1];
          const x = offsetX + (ptX - minX) * scale;
          const y = isPreProjected ? (offsetY + (ptY - minY) * scale) : (offsetY + (maxY - ptY) * scale);

          let isLevel3 = (keyField === 'county' && state.selectedMapCounty);
          let isLevel2 = (keyField === 'county' && !state.selectedMapCounty) || (keyField === 'state' && state.filterState);
          let isLevel1 = (keyField === 'state' && !state.filterState);

          let fSize = '8px';
          let subSize = '6px';
          let dyVal = '8';

          if (isLevel3) {
            fSize = '15px';
            subSize = '11px';
            dyVal = '14';
          } else if (isLevel2) {
            fSize = '8.5px';
            subSize = '6.5px';
            dyVal = '8.5';
          } else {
            fSize = '8px';
            subSize = '6px';
            dyVal = '8';
          }

          const isTwoLines = (colorMode === 'total' && isTimeframeActive && addedCount > 0);

          const labelWidth = isTwoLines
            ? Math.max(endTotal.toString().length, `(+${addedCount})`.length) * (isLevel3 ? 9 : 5.5) + 4
            : labelText.length * (isLevel3 ? 9 : 5.5) + 4;
            
          const labelHeight = isTwoLines
            ? (isLevel3 ? 30 : 18)
            : (isLevel3 ? 18 : 11);

          let finalY = y;
          let shifted = false;
          const shiftStep = isLevel3 ? 12 : 6;
          const shifts = [0, -shiftStep, shiftStep];
          for (const shift of shifts) {
            const testY = y + shift;
            const testBox = {
              minX: x - labelWidth / 2,
              maxX: x + labelWidth / 2,
              minY: testY - labelHeight / 2,
              maxY: testY + labelHeight / 2
            };
            
            let overlaps = false;
            for (const placed of placedLabels) {
              if (!(testBox.minX > placed.maxX + 2 || 
                    testBox.maxX < placed.minX - 2 || 
                    testBox.minY > placed.maxY + 2 || 
                    testBox.maxY < placed.minY - 2)) {
                overlaps = true;
                break;
              }
            }
            
            if (!overlaps) {
              finalY = testY;
              if (shift !== 0) {
                shifted = true;
              }
              break;
            }
          }
          
          placedLabels.push({
            minX: x - labelWidth / 2,
            maxX: x + labelWidth / 2,
            minY: finalY - labelHeight / 2,
            maxY: finalY + labelHeight / 2
          });
          
          if (shifted && Math.abs(finalY - y) > 12) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', y);
            line.setAttribute('x2', x);
            line.setAttribute('y2', finalY);
            line.setAttribute('stroke', 'rgba(255, 255, 255, 0.4)');
            line.setAttribute('stroke-width', '0.6px');
            line.setAttribute('stroke-dasharray', '1, 2');
            fragmentLabels.appendChild(line);
          }
          
          let drawY = finalY + (isLevel3 ? 5 : 3);
          if (isTwoLines) {
            drawY -= parseFloat(dyVal) / 2;
          }

          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('class', 'map-label');
          text.setAttribute('x', x);
          text.setAttribute('y', drawY);
          text.setAttribute('text-anchor', 'middle');
          text.style.pointerEvents = 'none';
          text.style.fontSize = fSize;
          text.style.fontFamily = 'Inter, system-ui, -apple-system, sans-serif';
          text.style.fontWeight = 'bold';
          text.style.fill = '#fff';
          text.style.textShadow = '0 1px 3px rgba(0,0,0,0.9)';

          if (isTwoLines) {
            // Line 1: End Total
            const tspanTotal = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            tspanTotal.textContent = endTotal.toString();
            text.appendChild(tspanTotal);

            // Line 2: Added Gains
            const tspanAdded = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            tspanAdded.textContent = `(+${addedCount})`;
            tspanAdded.setAttribute('x', x); // Keep centered horizontally
            tspanAdded.setAttribute('dy', dyVal); // Shift down
            tspanAdded.setAttribute('font-size', subSize);
            tspanAdded.setAttribute('fill', '#14b8a6'); // Teal green for gains
            text.appendChild(tspanAdded);
          } else {
            text.textContent = labelText;
          }

          fragmentLabels.appendChild(text);
        }
      }
    }

    DOM.mapNodesLayer.appendChild(fragmentPaths);
    DOM.mapLabelsLayer.appendChild(fragmentLabels);
  }

  function renderCentroidFallback(subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, endTotalCounts) {
    DOM.mapNodesLayer.innerHTML = '';
    DOM.mapEdgesLayer.innerHTML = '';
    DOM.mapLabelsLayer.innerHTML = '';

    const nodes = Array.from(subregionsMap.values());
    if (nodes.length === 0) return;

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const n of nodes) {
      if (n.lat < minLat) minLat = n.lat;
      if (n.lat > maxLat) maxLat = n.lat;
      if (n.lng < minLng) minLng = n.lng;
      if (n.lng > maxLng) maxLng = n.lng;
    }

    const latDiff = maxLat - minLat;
    const lngDiff = maxLng - minLng;

    const width = 500;
    const height = 400;
    const padding = 25;

    function project(lat, lng) {
      let x, y;
      if (lngDiff === 0) {
        x = width / 2;
      } else {
        x = padding + ((lng - minLng) / lngDiff) * (width - 2 * padding);
      }
      if (latDiff === 0) {
        y = height / 2;
      } else {
        y = height - (padding + ((lat - minLat) / latDiff) * (height - 2 * padding));
      }
      return { x, y };
    }

    if (DOM.mapLegendMin && DOM.mapLegendMax) {
      DOM.mapLegendMin.textContent = '0';
      DOM.mapLegendMax.textContent = activeMax > 0 ? activeMax.toString() : 'Max';
    }

    const projectedNodes = nodes.map(n => {
      const pt = project(n.lat, n.lng);
      return {
        ...n,
        x: pt.x,
        y: pt.y
      };
    });

    const fragmentEdges = document.createDocumentFragment();
    for (let i = 0; i < projectedNodes.length; i++) {
      const nodeA = projectedNodes[i];
      const neighbors = projectedNodes
        .filter((_, idx) => idx !== i)
        .map(nodeB => {
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          return { node: nodeB, dist: dx * dx + dy * dy };
        })
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2);

      for (const edge of neighbors) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', nodeA.x);
        line.setAttribute('y1', nodeA.y);
        line.setAttribute('x2', edge.node.x);
        line.setAttribute('y2', edge.node.y);
        line.setAttribute('stroke', 'var(--color-border-subtle)');
        line.setAttribute('stroke-width', '1px');
        line.setAttribute('stroke-dasharray', '2, 4');
        fragmentEdges.appendChild(line);
      }
    }
    DOM.mapEdgesLayer.appendChild(fragmentEdges);

    const fragmentNodes = document.createDocumentFragment();
    const fragmentLabels = document.createDocumentFragment();

    for (const node of projectedNodes) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'county-node-outer' + (state.selectedMapCounty === node.county ? ' is-selected' : ''));
      g.dataset.county = node.county;

      const lookupKey = `${node.state}::${node.county}`;
      const addedCount = addedCounts.get(lookupKey) || 0;
      const activeValue = colorMode === 'added' ? addedCount : node.speciesCount;

      const isTopCounty = activeMax > 0 && activeValue === activeMax;
      if (isTopCounty) {
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('class', 'county-node-glow-ring');
        ring.setAttribute('cx', node.x);
        ring.setAttribute('cy', node.y);
        ring.setAttribute('r', '15');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', 'var(--color-accent)');
        ring.setAttribute('stroke-width', '1px');
        g.appendChild(ring);
      }

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'county-node');
      circle.setAttribute('cx', node.x);
      circle.setAttribute('cy', node.y);
      circle.setAttribute('r', '11');

      let fill = 'rgba(255, 255, 255, 0.09)';
      let stroke = 'rgba(255, 255, 255, 0.22)';

      if (activeValue > 0) {
        const ratio = activeMax > 0 ? activeValue / activeMax : 0;
        const hue = 55 - 55 * ratio;
        const saturation = 100;
        const lightness = 65 - 17 * ratio;
        fill = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        stroke = '#475569';
      }
      circle.setAttribute('fill', fill);
      circle.setAttribute('stroke', stroke);
      circle.setAttribute('stroke-width', '1.5px');
      g.appendChild(circle);

      g.addEventListener('mouseenter', (e) => {
        showMapTooltip({ 
          county: `${node.county} County`, 
          state: node.state, 
          speciesCount: node.speciesCount,
          addedCount: addedCount,
          isTimeframeActive: isTimeframeActive
        }, e);
      });
      g.addEventListener('mouseleave', hideMapTooltip);
      g.addEventListener('mousemove', positionMapTooltip);
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        handleMapNodeClick(node.county);
      });

      fragmentNodes.appendChild(g);

      let labelText = '';
      const endTotalSet = endTotalCounts ? endTotalCounts.get(lookupKey) : null;
      const endTotal = endTotalSet ? endTotalSet.size : node.speciesCount;
      if (activeValue > 0) {
        if (colorMode === 'total') {
          if (isTimeframeActive) {
            labelText = endTotal.toString();
            if (addedCount > 0) {
              labelText += ` (+${addedCount})`;
            }
          } else {
            labelText = node.speciesCount.toString();
          }
        } else {
          labelText = addedCount > 0 ? `+${addedCount}` : '';
        }
      }

      if (labelText) {
        const isTwoLines = (colorMode === 'total' && isTimeframeActive && addedCount > 0);
        let fSize = '8.5px';
        let subSize = '6.5px';
        let dyVal = '8.5';

        let drawY = node.y + 3;
        if (isTwoLines) {
          drawY -= parseFloat(dyVal) / 2;
        }

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('class', 'map-label');
        text.setAttribute('x', node.x);
        text.setAttribute('y', drawY);
        text.setAttribute('text-anchor', 'middle');
        text.style.pointerEvents = 'none';
        text.style.fontSize = fSize;
        text.style.fontFamily = 'Inter, system-ui, -apple-system, sans-serif';
        text.style.fontWeight = 'bold';
        text.style.fill = '#fff';
        text.style.textShadow = '0 1px 3px rgba(0,0,0,0.9)';

        if (isTwoLines) {
          // Line 1: End Total
          const tspanTotal = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          tspanTotal.textContent = endTotal.toString();
          text.appendChild(tspanTotal);

          // Line 2: Added Gains
          const tspanAdded = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          tspanAdded.textContent = `(+${addedCount})`;
          tspanAdded.setAttribute('x', node.x); // Keep centered horizontally
          tspanAdded.setAttribute('dy', dyVal); // Shift down
          tspanAdded.setAttribute('font-size', subSize);
          tspanAdded.setAttribute('fill', '#14b8a6'); // Teal green for gains
          text.appendChild(tspanAdded);
        } else {
          text.textContent = labelText;
        }

        fragmentLabels.appendChild(text);
      }
    }

    DOM.mapNodesLayer.appendChild(fragmentNodes);
    DOM.mapLabelsLayer.appendChild(fragmentLabels);
  }

  function renderTickMap(subregionsMap, maxSpeciesCount) {
    const colorMode = DOM.mapColorMode ? DOM.mapColorMode.value : 'total';
    const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);
    const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';

    // Update zoom-out button visibility and text
    if (DOM.btnMapZoomOut) {
      if (state.selectedMapCounty) {
        DOM.btnMapZoomOut.classList.remove('is-hidden');
        DOM.btnMapZoomOut.textContent = `⬅️ Zoom Out to ${cleanStateCode(state.filterState)}`;
      } else if (state.filterState) {
        DOM.btnMapZoomOut.classList.remove('is-hidden');
        DOM.btnMapZoomOut.textContent = '⬅️ Zoom Out to US';
      } else {
        DOM.btnMapZoomOut.classList.add('is-hidden');
      }
    }

    // Compute timeframe additions count for all subregions
    const addedCounts = new Map();
    const endTotalCounts = new Map();
    for (const m of state.tickMilestones) {
      const cKey = isStateLevel ? m.state : `${m.state}::${m.county}`;
      if (!addedCounts.has(cKey)) {
        addedCounts.set(cKey, 0);
      }
      if (!endTotalCounts.has(cKey)) {
        endTotalCounts.set(cKey, new Set());
      }
      
      let isWithin = true;
      if (state.tickDateStart && m.date < state.tickDateStart) isWithin = false;
      if (state.tickDateEnd && m.date > state.tickDateEnd) isWithin = false;
      
      if (isWithin) {
        addedCounts.set(cKey, addedCounts.get(cKey) + 1);
      }

      if (!state.tickDateEnd || m.date <= state.tickDateEnd) {
        endTotalCounts.get(cKey).add(m.commonName);
      }
    }

    // Calculate max values for both Total and Added
    let maxTotal = 0;
    let maxAdded = 0;
    for (const [key, sub] of subregionsMap) {
      if (sub.speciesCount > maxTotal) maxTotal = sub.speciesCount;
      const added = addedCounts.get(key) || 0;
      if (added > maxAdded) maxAdded = added;
    }

    const activeMax = colorMode === 'added' ? maxAdded : maxTotal;

    if (typeof topojson !== 'undefined' && window.US_ATLAS) {
      try {
        const cleanedState = cleanStateCode(state.filterState);
        
        if (!cleanedState) {
          const stateFeatures = topojson.feature(window.US_ATLAS, window.US_ATLAS.objects.states).features;
          renderVectorMap(stateFeatures, 'state', subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, true, endTotalCounts);
          return;
        } else {
          const fipsPrefix = STATE_TO_FIPS[cleanedState];
          if (fipsPrefix) {
            if (isStateLevel) {
              const stateFeatures = topojson.feature(window.US_ATLAS, window.US_ATLAS.objects.states).features;
              const stateFeature = stateFeatures.find(f => f.id === fipsPrefix);
              if (stateFeature) {
                renderVectorMap([stateFeature], 'state', subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, true, endTotalCounts);
                return;
              }
            } else {
              const countyFeatures = topojson.feature(window.US_ATLAS, window.US_ATLAS.objects.counties).features.filter(
                f => f.id.startsWith(fipsPrefix)
              );
              if (countyFeatures.length > 0) {
                renderVectorMap(countyFeatures, 'county', subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, true, endTotalCounts);
                return;
              }
            }
          }
        }
      } catch (err) {
        console.error('Error rendering vector boundary map:', err);
      }
    }
    
    renderCentroidFallback(subregionsMap, addedCounts, activeMax, colorMode, isTimeframeActive, endTotalCounts);
  }

  function renderTickChart(milestones) {
    if (state.tickChartInstance) {
      state.tickChartInstance.destroy();
      state.tickChartInstance = null;
    }

    if (typeof Chart === 'undefined') return;

    const ctx = $('tick-chart').getContext('2d');
    if (!ctx || milestones.length === 0) return;

    const chartPoints = [];
    let count = 0;

    for (const m of milestones) {
      count++;
      const parts = m.date.split('-');
      const date = new Date(parts[0], parts[1] - 1, parts[2]);
      chartPoints.push({
        x: date,
        y: count
      });
    }

    // If timeframe is active, we highlight that segment in red and fade the historical trend to grey
    const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);

    // Build datasets - main line always shown in premium green/teal
    const datasets = [{
      label: 'Cumulative County Ticks',
      data: chartPoints,
      borderColor: 'rgb(20, 184, 166)',
      backgroundColor: 'rgba(20, 184, 166, 0.05)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: 'rgb(20, 184, 166)',
      tension: 0.15,
      fill: true,
      order: 2 // Draw first (underneath)
    }];

    if (isTimeframeActive) {
      const highlightPoints = [];
      let runningCount = 0;
      for (const m of milestones) {
        runningCount++;
        const inRange = (!state.tickDateStart || m.date >= state.tickDateStart) &&
                        (!state.tickDateEnd || m.date <= state.tickDateEnd);
        if (inRange) {
          const parts = m.date.split('-');
          highlightPoints.push({
            x: new Date(parts[0], parts[1] - 1, parts[2]),
            y: runningCount
          });
        }
      }
      datasets.push({
        label: 'Timeframe Window',
        data: highlightPoints,
        borderColor: 'rgba(239, 68, 68, 1.0)',
        backgroundColor: 'rgba(239, 68, 68, 0.15)',
        borderWidth: 3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: 'rgb(239, 68, 68)',
        tension: 0.15,
        fill: true,
        order: 1 // Draw last (on top)
      });
    }

    state.tickChartInstance = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleColor: '#fff',
            titleFont: { family: 'Inter', weight: 'bold' },
            bodyColor: '#e2e8f0',
            bodyFont: { family: 'Inter' },
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 8,
            cornerRadius: 6,
            filter: (tooltipItem) => tooltipItem.datasetIndex === 0,
            callbacks: {
              title: (context) => {
                const idx = context[0].dataIndex;
                const m = milestones[idx];
                const parts = m.date.split('-');
                const d = new Date(parts[0], parts[1] - 1, parts[2]);
                return formatDateLabel(d);
              },
              label: (context) => {
                const idx = context.dataIndex;
                const m = milestones[idx];
                return [
                  `Total: ${context.parsed.y} ticks`,
                  `New Sighting: ${m.commonName}`,
                  `Subregion: ${m.county}, ${m.state}`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'year',
              displayFormats: {
                year: 'yyyy'
              },
              tooltipFormat: 'MMM d, yyyy'
            },
            grid: { display: false },
            ticks: {
              color: '#64748b',
              font: { size: 9, family: 'JetBrains Mono' },
              maxTicksLimit: 10
            }
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: {
              color: '#64748b',
              font: { size: 9, family: 'JetBrains Mono' }
            }
          }
        }
      }
    });
  }

  function renderTimeframeAdditions() {
    DOM.timelineAdditionsList.innerHTML = '';
    
    const filtered = state.tickMilestones.filter(m => {
      if (state.selectedMapCounty && m.county !== state.selectedMapCounty) return false;
      if (state.tickDateStart && m.date < state.tickDateStart) return false;
      if (state.tickDateEnd && m.date > state.tickDateEnd) return false;
      return true;
    });

    DOM.timelineAdditionsTitle.textContent = `⏱️ Timeframe Additions (${filtered.length.toLocaleString()})`;

    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.style.padding = 'var(--space-4)';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--color-text-tertiary)';
      empty.style.fontSize = 'var(--font-size-xs)';
      empty.textContent = 'No additions found in this date window.';
      DOM.timelineAdditionsList.appendChild(empty);
      return;
    }

    const sorted = [...filtered].reverse().slice(0, 50);

    const fragment = document.createDocumentFragment();
    for (const m of sorted) {
      const li = document.createElement('li');
      li.className = 'timeline-addition-item';

      const marker = document.createElement('div');
      marker.className = 'timeline-addition-item__marker';
      li.appendChild(marker);

      const content = document.createElement('div');
      content.className = 'timeline-addition-item__content';

      const title = document.createElement('span');
      title.className = 'timeline-addition-item__title';
      title.textContent = m.commonName;
      content.appendChild(title);

      const sub = document.createElement('span');
      sub.className = 'timeline-addition-item__sub';
      
      const subregion = document.createElement('span');
      subregion.textContent = `${m.county}, ${m.state}`;
      sub.appendChild(subregion);

      const dot = document.createElement('span');
      dot.textContent = '•';
      dot.style.color = 'var(--color-text-tertiary)';
      sub.appendChild(dot);

      const dateStr = document.createElement('span');
      dateStr.className = 'timeline-addition-item__date';
      const parts = m.date.split('-');
      const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
      dateStr.textContent = formatDateLabel(dateObj);
      sub.appendChild(dateStr);

      content.appendChild(sub);
      li.appendChild(content);
      fragment.appendChild(li);
    }

    DOM.timelineAdditionsList.appendChild(fragment);
  }

  function handleMapNodeClick(countyName) {
    if (state.selectedMapCounty === countyName) {
      state.selectedMapCounty = '';
    } else {
      state.selectedMapCounty = countyName;
    }

    const groups = DOM.mapNodesLayer.querySelectorAll('g');
    groups.forEach(g => {
      if (g.dataset.county === countyName) {
        g.classList.add('is-selected');
      } else {
        g.classList.remove('is-selected');
      }
    });

    renderTickExplorer();

    if (state.selectedMapCounty) {
      const rows = DOM.subregionListBody.querySelectorAll('tr');
      for (const tr of rows) {
        const td = tr.querySelector('td');
        if (td && td.textContent === state.selectedMapCounty) {
          const container = document.querySelector('.subregion-list-wrapper');
          if (container) {
            const rowTop = tr.offsetTop;
            const rowHeight = tr.offsetHeight;
            const containerScrollTop = container.scrollTop;
            const containerHeight = container.clientHeight;
            const thead = container.querySelector('thead');
            const headerHeight = thead ? thead.offsetHeight : 32;

            if (rowTop < containerScrollTop + headerHeight) {
              container.scrollTo({
                top: rowTop - headerHeight,
                behavior: 'smooth'
              });
            } else if (rowTop + rowHeight > containerScrollTop + containerHeight) {
              container.scrollTo({
                top: rowTop + rowHeight - containerHeight,
                behavior: 'smooth'
              });
            }
          }
          break;
        }
      }
    }
  }

  function showMapTooltip(node, event) {
    DOM.mapTooltip.style.display = 'block';
    
    let valueHTML = `<div class="map-tooltip__value">${node.speciesCount} Lifetime Ticks</div>`;
    if (node.isTimeframeActive) {
      valueHTML += `<div class="map-tooltip__value" style="color: #14b8a6; font-size: var(--font-size-xs); margin-top: 2px;">+${node.addedCount || 0} Timeframe Additions</div>`;
    }
    
    DOM.mapTooltip.innerHTML = `
      <div class="map-tooltip__title">${node.county}, ${node.state}</div>
      ${valueHTML}
      <div style="font-size: 10px; color: var(--color-text-tertiary); margin-top: 4px;">Click to filter/select</div>
    `;
    positionMapTooltip(event);
  }

  function hideMapTooltip() {
    DOM.mapTooltip.style.display = 'none';
  }

  function positionMapTooltip(event) {
    const mapContainerRect = $('map-container').getBoundingClientRect();
    const x = event.clientX - mapContainerRect.left;
    const y = event.clientY - mapContainerRect.top;
    
    DOM.mapTooltip.style.left = `${x}px`;
    DOM.mapTooltip.style.top = `${y}px`;
  }

  /* -----------------------------------------------------------------------
     14. Event Handlers
     ----------------------------------------------------------------------- */

  function handleSort(column) {
    if (state.sortColumn === column) {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortColumn = column;
      state.sortDirection = 'asc';
    }
    computeSpeciesData();
    renderGrid();
  }

  function handleYearHeaderClick(year) {
    const current = state.yearFilters[year] || 'all';
    let next = 'all';
    if (current === 'all') next = 'seen';
    else if (current === 'seen') next = 'unseen';

    if (next === 'all') {
      delete state.yearFilters[year];
    } else {
      state.yearFilters[year] = next;
    }

    computeSpeciesData();
    renderGrid();
    updateStats();
    updateAlerts();
  }

  function handleToggleTarget(commonName, isTarget) {
    DB.setTarget(commonName, isTarget).then(() => {
      if (isTarget) {
        state.targets.set(commonName, { commonName, isTarget: true, addedAt: new Date().toISOString() });
      } else {
        state.targets.delete(commonName);
      }
      computeSpeciesData();
      renderGrid();
      updateStats();
      updateAlerts();
    });
  }

  async function handleExportState() {
    try {
      const targets = await DB.getTargets();
      const settings = await DB.getAllSettings();
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        targets,
        settings,
        filterState: state.filterState,
        filterCounty: state.filterCounty,
      };

      const json = JSON.stringify(exportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.href = url;
      a.download = `ebird-tracker-state-${formatDateISO(new Date())}.json`;
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Dashboard state exported successfully!', 'success');
    } catch (err) {
      showToast('Export error: ' + err.message, 'error');
    }
  }

  async function handleImportState(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.targets) {
        await DB.clearTargets();
        await DB.putTargets(data.targets);
      }
      if (data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
          await DB.setSetting(key, value);
        }
      }
      if (data.filterState) {
        state.filterState = data.filterState;
        DOM.filterState.value = data.filterState;
      }
      if (data.filterCounty) {
        state.filterCounty = data.filterCounty;
        DOM.filterCounty.value = data.filterCounty;
      }

      showToast('Dashboard state imported successfully!', 'success');
      await initDashboard();
    } catch (err) {
      showToast('Import error: ' + err.message, 'error');
    }
  }

  async function handleClearData() {
    if (!confirm('Are you sure you want to clear ALL data? This will remove all observations, targets, and settings. This cannot be undone.')) {
      return;
    }
    try {
      await DB.clearAll();
      state.targets.clear();
      state.observations = [];
      state.speciesData = [];
      state.isDataLoaded = false;
      DOM.alertsPanel.classList.remove('is-open');
      DOM.importProgress.style.display = 'none';
      DOM.importStatus.style.display = 'none';
      DOM.statTotalRecords.textContent = '0';
      DOM.statTotalSpecies.textContent = '0';
      DOM.statDateAsOf.textContent = '—';
      
      // Clean up Chart.js
      if (state.tickChartInstance) {
        state.tickChartInstance.destroy();
        state.tickChartInstance = null;
      }
      state.tickMilestones = [];
      state.selectedMapCounty = '';
      state.tickDateStart = '';
      state.tickDateEnd = '';
      
      syncViewVisibility();
      showToast('All data cleared.', 'warning');
    } catch (err) {
      showToast('Clear error: ' + err.message, 'error');
    }
  }

  /* -----------------------------------------------------------------------
     13.7. Settings View Controller (Exclusions)
     ----------------------------------------------------------------------- */

  async function populateSettingsForms() {
    if (!state.isDataLoaded) return;

    try {
      const allObs = await DB.getObservations();

      // 1. Populate autocomplete datalist for species
      const speciesSet = new Set();
      for (const obs of allObs) {
        if (state.showTrueSpeciesOnly && !isTrueSpecies(obs.commonName, obs.scientificName)) {
          continue;
        }
        let name = obs.commonName;
        if (state.aggregateSubspecies) {
          name = stripSubspecies(name);
        }
        speciesSet.add(name);
      }
      
      const sortedSpecies = [...speciesSet].sort();
      DOM.datalistSpecies.innerHTML = '';
      for (const sp of sortedSpecies) {
        const opt = document.createElement('option');
        opt.value = sp;
        DOM.datalistSpecies.appendChild(opt);
      }

      // 2. Populate State selection dropdown
      const states = [...new Set(state.regions.map(r => r.state))].filter(Boolean).sort();
      DOM.exclusionState.innerHTML = '<option value="">Select State</option>';
      for (const s of states) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        DOM.exclusionState.appendChild(opt);
      }

      // Clear county dropdown on load
      DOM.exclusionCounty.innerHTML = '<option value="">All Counties</option>';
    } catch (err) {
      console.error('Error populating settings autocomplete:', err);
    }
  }

  async function renderSettings() {
    // 1. Render custom user exclusions
    DOM.userExclusionsBody.innerHTML = '';
    if (state.userExclusions.length === 0) {
      DOM.userExclusionsBody.innerHTML = `
        <tr>
          <td colspan="3" style="text-align: center; color: var(--color-text-tertiary); font-style: italic; padding: var(--space-4);">
            No custom exclusions defined.
          </td>
        </tr>`;
    } else {
      const fragment = document.createDocumentFragment();
      for (const rule of state.userExclusions) {
        const tr = document.createElement('tr');

        const tdSpecies = document.createElement('td');
        tdSpecies.style.fontWeight = '500';
        tdSpecies.textContent = rule.commonName;
        tr.appendChild(tdSpecies);

        const tdRegion = document.createElement('td');
        tdRegion.className = 'date-cell';
        tdRegion.textContent = rule.county ? `${rule.county} Co., ${rule.state}` : `${rule.state}`;
        tr.appendChild(tdRegion);

        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn--danger btn--xs';
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.title = 'Delete exclusion rule';
        deleteBtn.addEventListener('click', () => handleDeleteExclusion(rule.id));
        tdAction.appendChild(deleteBtn);
        tr.appendChild(tdAction);

        fragment.appendChild(tr);
      }
      DOM.userExclusionsBody.appendChild(fragment);
    }

    // 2. Render system default exclusions
    DOM.systemExclusionsBody.innerHTML = '';
    const fragmentSys = document.createDocumentFragment();
    for (const rule of SYSTEM_EXCLUSIONS) {
      const tr = document.createElement('tr');

      const tdSpecies = document.createElement('td');
      tdSpecies.style.fontWeight = '500';
      tdSpecies.textContent = rule.commonName;
      tr.appendChild(tdSpecies);

      const tdRegion = document.createElement('td');
      tdRegion.className = 'date-cell';
      tdRegion.textContent = rule.county ? `${rule.county} Co., ${rule.state}` : `${rule.state}`;
      tr.appendChild(tdRegion);

      const tdStatus = document.createElement('td');
      tdStatus.style.textAlign = 'right';
      
      const isEnabled = !state.disabledSystemExclusions.includes(rule.id);
      
      const label = document.createElement('label');
      label.className = 'control-toggle';
      label.title = isEnabled ? 'Exclusion Active (Sightings will not be counted)' : 'Exclusion Disabled (Sightings will be counted)';
      
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = isEnabled;
      input.addEventListener('change', (e) => handleToggleSystemExclusion(rule.id, e.target.checked));
      
      const track = document.createElement('span');
      track.className = 'control-toggle__track';
      
      label.appendChild(input);
      label.appendChild(track);
      tdStatus.appendChild(label);
      tr.appendChild(tdStatus);

      fragmentSys.appendChild(tr);
    }
    DOM.systemExclusionsBody.appendChild(fragmentSys);
  }

  async function handleAddExclusion(e) {
    if (e) e.preventDefault();

    const species = DOM.exclusionSpecies.value.trim();
    const stateCode = DOM.exclusionState.value;
    const countyName = DOM.exclusionCounty.value;

    if (!species || !stateCode) {
      showToast('Please specify a species and a state.', 'error');
      return;
    }

    // TYPO PROTECTION: Ensure species exists in loaded data
    const datasetSpecies = new Set();
    for (const obs of state.observations) {
      datasetSpecies.add(obs.commonName.trim().toLowerCase());
      datasetSpecies.add(stripSubspecies(obs.commonName).trim().toLowerCase());
    }

    if (!datasetSpecies.has(species.toLowerCase())) {
      showToast(`Species "${species}" was not found in your observations database. Please check the spelling.`, 'warning');
      return;
    }

    // DUPLICATE PROTECTION: Ensure rule is unique
    const duplicate = state.userExclusions.find(rule => 
      rule.commonName.toLowerCase() === species.toLowerCase() &&
      rule.state.toLowerCase() === stateCode.toLowerCase() &&
      rule.county.toLowerCase() === countyName.toLowerCase()
    );

    if (duplicate) {
      showToast('This exclusion rule already exists.', 'warning');
      return;
    }

    const newRule = {
      id: 'user-' + Date.now(),
      commonName: species,
      state: stateCode,
      county: countyName
    };

    state.userExclusions.push(newRule);
    await DB.setSetting('userExclusions', state.userExclusions);
    showToast(`Exclusion rule for ${species} created successfully!`, 'success');

    // Reset species input
    DOM.exclusionSpecies.value = '';
    
    // Render and refresh calculations
    await renderSettings();
    await refreshGrid();
  }

  async function handleDeleteExclusion(id) {
    state.userExclusions = state.userExclusions.filter(rule => rule.id !== id);
    await DB.setSetting('userExclusions', state.userExclusions);
    showToast('Exclusion rule deleted.', 'info');

    await renderSettings();
    await refreshGrid();
  }

  async function handleToggleSystemExclusion(id, enabled) {
    if (enabled) {
      // Enabling exclusion means removing from disabled list
      state.disabledSystemExclusions = state.disabledSystemExclusions.filter(sysId => sysId !== id);
      showToast('System exclusion activated (Sightings will not be counted).', 'info');
    } else {
      // Disabling exclusion means adding to disabled list
      if (!state.disabledSystemExclusions.includes(id)) {
        state.disabledSystemExclusions.push(id);
      }
      showToast('System exclusion deactivated (Sightings will be counted).', 'success');
    }
    await DB.setSetting('disabledSystemExclusions', state.disabledSystemExclusions);

    await renderSettings();
    await refreshGrid();
  }

  /* -----------------------------------------------------------------------
     15. Event Binding
     ----------------------------------------------------------------------- */

  function bindEvents() {
    // Prevent default drag & drop behaviors on the entire window
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    }, false);
    window.addEventListener('drop', (e) => {
      e.preventDefault();
    }, false);

    // File import
    DOM.inputFile.addEventListener('change', (e) => handleFileImport(e.target.files[0]));
    DOM.inputFileDrop.addEventListener('change', (e) => handleFileImport(e.target.files[0]));

    // Drop zone drag & drop
    DOM.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      DOM.dropZone.classList.add('is-dragover');
    });
    DOM.dropZone.addEventListener('dragleave', () => {
      DOM.dropZone.classList.remove('is-dragover');
    });
    DOM.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      DOM.dropZone.classList.remove('is-dragover');
      const file = e.dataTransfer.files[0];
      handleFileImport(file);
    });

    // Mock data
    DOM.btnLoadMock.addEventListener('click', generateMockData);
    DOM.btnLoadMockMain.addEventListener('click', generateMockData);

    // Export / Import state
    DOM.btnExportState.addEventListener('click', handleExportState);
    DOM.inputImportState.addEventListener('change', (e) => handleImportState(e.target.files[0]));

    // Clear data
    DOM.btnClearData.addEventListener('click', handleClearData);

    // Region filters
    DOM.filterState.addEventListener('change', (e) => {
      state.filterState = e.target.value;
      state.filterCounty = '';
      state.selectedMapCounty = '';
      populateCountyFilter();
      DB.setSetting('filterState', state.filterState);
      DB.setSetting('filterCounty', '');
      if (state.isDataLoaded) refreshGrid();
    });

    DOM.filterCounty.addEventListener('change', (e) => {
      state.filterCounty = e.target.value;
      state.selectedMapCounty = '';
      DB.setSetting('filterCounty', state.filterCounty);
      if (state.isDataLoaded) refreshGrid();
    });

    // Year filter
    DOM.filterYear.addEventListener('change', (e) => {
      state.targetYear = parseInt(e.target.value, 10);
      if (state.isDataLoaded) refreshGrid();
    });

    // Simulated date
    DOM.filterSimDate.addEventListener('change', (e) => {
      state.simDate = new Date(e.target.value + 'T00:00:00');
      if (state.isDataLoaded) refreshGrid();
    });

    // Search
    DOM.filterSearch.addEventListener('input', debounce(() => {
      state.searchQuery = DOM.filterSearch.value.trim();
      if (state.isDataLoaded) {
        computeSpeciesData();
        renderGrid();
        updateStats();
        updateAlerts();
      }
    }, 200));

    // Toggles
    DOM.toggleAggregate.addEventListener('change', (e) => {
      state.aggregateSubspecies = e.target.checked;
      DB.setSetting('aggregateSubspecies', state.aggregateSubspecies);
      if (state.isDataLoaded) refreshGrid();
    });
    DOM.toggleTrueSpecies.addEventListener('change', (e) => {
      state.showTrueSpeciesOnly = e.target.checked;
      DB.setSetting('showTrueSpeciesOnly', state.showTrueSpeciesOnly);
      if (state.isDataLoaded) refreshGrid();
    });
    DOM.toggleTargetsOnly.addEventListener('change', (e) => {
      state.targetsOnly = e.target.checked;
      if (state.isDataLoaded) {
        computeSpeciesData();
        renderGrid();
        updateStats();
      }
    });
    DOM.togglePastDueOnly.addEventListener('change', (e) => {
      state.pastDueOnly = e.target.checked;
      if (state.isDataLoaded) {
        computeSpeciesData();
        renderGrid();
        updateStats();
      }
    });

    // Alerts toggle
    DOM.btnToggleAlerts.addEventListener('click', () => {
      const panel = DOM.alertsPanel;
      if (panel.classList.contains('is-open')) {
        panel.classList.remove('is-open');
        DOM.btnToggleAlerts.textContent = 'Show';
      } else {
        panel.classList.add('is-open');
        DOM.btnToggleAlerts.textContent = 'Hide';
      }
    });

    // Tab Navigation
    DOM.tabYoY.addEventListener('click', () => switchTab('yoy'));
    DOM.tabTick.addEventListener('click', () => switchTab('tick'));
    DOM.tabSettings.addEventListener('click', () => switchTab('settings'));

    // Tick Date range analyzer
    DOM.tickDateStart.addEventListener('change', (e) => {
      state.tickDateStart = e.target.value;
      clearQuickPickActive();
      renderTickExplorer();
    });
    DOM.tickDateEnd.addEventListener('change', (e) => {
      state.tickDateEnd = e.target.value;
      clearQuickPickActive();
      renderTickExplorer();
    });
    DOM.btnClearDateFilter.addEventListener('click', () => {
      state.tickDateStart = '';
      state.tickDateEnd = '';
      DOM.tickDateStart.value = '';
      DOM.tickDateEnd.value = '';
      clearQuickPickActive();
      renderTickExplorer();
    });

    // Map display mode switch
    DOM.mapColorMode.addEventListener('change', () => {
      renderTickExplorer();
    });

    if (DOM.tickLevel) {
      DOM.tickLevel.addEventListener('change', () => {
        DB.setSetting('tickLevel', DOM.tickLevel.value);
        if (DOM.tickLevel.value === 'state') {
          state.selectedMapCounty = '';
          if (DOM.filterCounty) {
            DOM.filterCounty.value = '';
            DOM.filterCounty.disabled = true;
            state.filterCounty = '';
            DB.setSetting('filterCounty', '');
          }
        } else {
          if (DOM.filterCounty) {
            DOM.filterCounty.disabled = false;
          }
        }
        renderTickExplorer();
      });
    }

    if (DOM.toggleExportInfographic) {
      DOM.toggleExportInfographic.addEventListener('change', () => {
        DB.setSetting('toggleExportInfographic', DOM.toggleExportInfographic.checked);
      });
    }

    // Zoom Out floating button click
    if (DOM.btnMapZoomOut) {
      DOM.btnMapZoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectedMapCounty) {
          state.selectedMapCounty = '';
          renderTickExplorer();
        } else if (state.filterState) {
          state.filterState = '';
          DOM.filterState.value = '';
          DOM.filterState.dispatchEvent(new Event('change'));
        }
      });
    }

    // Map background empty space click to zoom out
    if (DOM.tickSvgMap) {
      DOM.tickSvgMap.addEventListener('click', (e) => {
        // Only trigger if clicking directly on the SVG or on grid lines/lines
        if (e.target === DOM.tickSvgMap || e.target.classList.contains('map-grid-lines') || e.target.tagName === 'line') {
          if (state.selectedMapCounty) {
            state.selectedMapCounty = '';
            renderTickExplorer();
          } else if (state.filterState) {
            state.filterState = '';
            DOM.filterState.value = '';
            DOM.filterState.dispatchEvent(new Event('change'));
          }
        }
      });
    }

    // Subregions search filter
    DOM.tickSearchSubregions.addEventListener('input', () => {
      state.tickSearchQuery = DOM.tickSearchSubregions.value.trim().toLowerCase();
      renderSubregionsList();
    });

    // Subregions table header sorting
    const subregionsTable = DOM.subregionListBody ? DOM.subregionListBody.closest('table') : null;
    if (subregionsTable) {
      const ths = subregionsTable.querySelectorAll('thead th');
      ths.forEach((th) => {
        th.addEventListener('click', () => {
          const colType = th.getAttribute('data-sort');
          if (!colType) return;
          if (state.tickSortColumn === colType) {
            state.tickSortDirection = state.tickSortDirection === 'asc' ? 'desc' : 'asc';
          } else {
            state.tickSortColumn = colType;
            state.tickSortDirection = (colType === 'name' || colType === 'state') ? 'asc' : 'desc';
          }
          renderSubregionsList();
        });
      });
    }

    // Quick-pick date presets
    document.querySelectorAll('.quick-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        const today = new Date();
        let start, end;

        switch (preset) {
          case 'this-year':
            start = new Date(today.getFullYear(), 0, 1);
            end = today;
            break;
          case 'this-month':
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            end = today;
            break;
          case 'last-year':
            start = new Date(today.getFullYear() - 1, 0, 1);
            end = new Date(today.getFullYear() - 1, 11, 31);
            break;
          case 'last-7':
            start = new Date(today.getTime() - 7 * 86400000);
            end = today;
            break;
          case 'last-30':
            start = new Date(today.getTime() - 30 * 86400000);
            end = today;
            break;
          case 'last-90':
            start = new Date(today.getTime() - 90 * 86400000);
            end = today;
            break;
          default:
            return;
        }

        state.tickDateStart = formatDateISO(start);
        state.tickDateEnd = formatDateISO(end);
        DOM.tickDateStart.value = state.tickDateStart;
        DOM.tickDateEnd.value = state.tickDateEnd;

        // Highlight active quick pick
        document.querySelectorAll('.quick-pick-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');

        renderTickExplorer();
      });
    });

    // Download map as PNG with rich metadata
    if (DOM.btnDownloadMap) {
      DOM.btnDownloadMap.addEventListener('click', () => {
        const svgEl = DOM.tickSvgMap;
        if (!svgEl) return;

        const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';

        // Gather geography context
        let geography = 'UNITED STATES';
        if (state.filterState) {
          const cleanState = cleanStateCode(state.filterState);
          geography = cleanState;
          if (!isStateLevel && state.selectedMapCounty) {
            geography = `${state.selectedMapCounty} County, ${cleanState}`;
          }
        }
        geography = geography.toUpperCase();

        let timeframe = 'All-Time';
        let beforeCount = 0;
        let addedCount = 0;
        let afterCount = 0;
        const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);

        // Filter milestones to geography context
        const geoMilestones = !isStateLevel && state.selectedMapCounty
          ? state.tickMilestones.filter(m => m.county === state.selectedMapCounty)
          : (state.filterState
             ? state.tickMilestones.filter(m => {
                 const cleanState = cleanStateCode(state.filterState);
                 return m.state === state.filterState || m.state.endsWith(cleanState);
               })
             : state.tickMilestones);

        if (isTimeframeActive) {
          let startStr = 'Start';
          if (state.tickDateStart) {
            const parts = state.tickDateStart.split('-');
            const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            startStr = formatDateLabel(dateObj);
          }
          let endStr = 'Present';
          if (state.tickDateEnd) {
            const parts = state.tickDateEnd.split('-');
            const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            endStr = formatDateLabel(dateObj);
          }
          timeframe = `${startStr} to ${endStr}`;

          beforeCount = state.tickDateStart
            ? geoMilestones.filter(m => m.date < state.tickDateStart).length
            : 0;
          afterCount = state.tickDateEnd
            ? geoMilestones.filter(m => m.date <= state.tickDateEnd).length
            : geoMilestones.length;
          addedCount = geoMilestones.filter(m => {
            if (state.tickDateStart && m.date < state.tickDateStart) return false;
            if (state.tickDateEnd && m.date > state.tickDateEnd) return false;
            return true;
          }).length;
        }

        const dataAsOf = DOM.statDateAsOf ? DOM.statDateAsOf.textContent : '—';
        const maxVal = DOM.mapLegendMax ? DOM.mapLegendMax.textContent : 'Max';

        let speciesCountText = '';
        if (!isStateLevel && state.selectedMapCounty) {
          speciesCountText = `${geoMilestones.length.toLocaleString()} Species Ticked`;
        } else {
          speciesCountText = `${geoMilestones.length.toLocaleString()} Total Ticks`;
        }

        const colorMode = DOM.mapColorMode ? DOM.mapColorMode.value : 'total';
        const modeTitle = colorMode === 'added' ? 'TIMEFRAME ADDITIONS' : 'TOTAL LIFETIME TICKS';

        let svgData = new XMLSerializer().serializeToString(svgEl);
        // Resolve CSS variables inside serialized SVG for standalone image rendering
        svgData = svgData.replace(/var\(--color-accent\)/g, '#14b8a6');
        svgData = svgData.replace(/var\(--color-border-subtle\)/g, 'rgba(255, 255, 255, 0.08)');
        const canvas = document.createElement('canvas');
        canvas.width = 2000;
        canvas.height = 1600;
        const ctx2 = canvas.getContext('2d');

        // Draw dark background
        ctx2.fillStyle = '#0f1729';
        ctx2.fillRect(0, 0, canvas.width, canvas.height);

        const img = new Image();
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        img.onload = () => {
          try {
            const exportInfographic = DOM.toggleExportInfographic ? DOM.toggleExportInfographic.checked : true;

            if (exportInfographic) {
              // Draw map SVG much larger (occupying 1800x1430 starting at Y = 130)
              ctx2.drawImage(img, 100, 130, 1800, 1430);
              URL.revokeObjectURL(url);

              // Draw Metadata Header (Left-aligned)
              ctx2.fillStyle = '#38bdf8';
              ctx2.font = '600 22px monospace';
              ctx2.textAlign = 'left';
              ctx2.fillText(`BIRDING TRACKER // ${modeTitle}`, 100, 50);

              ctx2.fillStyle = '#ffffff';
              ctx2.font = '700 48px system-ui, -apple-system, sans-serif';
              ctx2.fillText(geography, 100, 110);

              // Draw Metadata Header (Right-aligned in top right)
              ctx2.textAlign = 'right';
              ctx2.fillStyle = '#38bdf8';
              ctx2.font = '700 36px system-ui, -apple-system, sans-serif';
              ctx2.fillText(speciesCountText, 1900, 75);

              ctx2.fillStyle = '#94a3b8';
              ctx2.font = '600 22px system-ui, -apple-system, sans-serif';
              ctx2.fillText(`Data as of: ${dataAsOf}`, 1900, 115);

              // Horizontal divider line
              ctx2.strokeStyle = 'rgba(255, 255, 255, 0.08)';
              ctx2.lineWidth = 2;
              ctx2.beginPath();
              ctx2.moveTo(100, 150);
              ctx2.lineTo(1900, 150);
              ctx2.stroke();

              // CONDITIONAL: Timeframe Box on the right of the map (only drawn if active)
              if (isTimeframeActive) {
                const boxX = 1400;
                const boxY = 180;
                const boxW = 500;
                const boxH = 320;

                // Draw glassmorphic Timeframe box
                ctx2.fillStyle = '#0f1729';
                ctx2.strokeStyle = 'rgba(255, 255, 255, 0.08)';
                ctx2.lineWidth = 2;
                ctx2.fillRect(boxX, boxY, boxW, boxH);
                ctx2.strokeRect(boxX, boxY, boxW, boxH);

                // Timeframe text drawings
                ctx2.textAlign = 'left';
                ctx2.fillStyle = '#94a3b8';
                ctx2.font = '600 18px system-ui, -apple-system, sans-serif';
                ctx2.fillText('TIMEFRAME ANALYSIS', boxX + 30, boxY + 45);

                ctx2.fillStyle = '#ffffff';
                ctx2.font = '700 24px system-ui, -apple-system, sans-serif';
                ctx2.fillText(timeframe, boxX + 30, boxY + 85);

                // Comma-formatted values aligned left/right
                ctx2.font = '600 22px system-ui, -apple-system, sans-serif';
                
                // Before
                ctx2.fillStyle = '#94a3b8';
                ctx2.textAlign = 'left';
                ctx2.fillText('Before ticks:', boxX + 30, boxY + 145);
                ctx2.fillStyle = '#ffffff';
                ctx2.textAlign = 'right';
                ctx2.fillText(beforeCount.toLocaleString(), boxX + 470, boxY + 145);

                // Gained
                ctx2.fillStyle = '#14b8a6';
                ctx2.textAlign = 'left';
                ctx2.fillText('Ticks gained:', boxX + 30, boxY + 200);
                ctx2.textAlign = 'right';
                ctx2.fillText(`+${addedCount.toLocaleString()}`, boxX + 470, boxY + 200);

                // After
                ctx2.fillStyle = '#a78bfa';
                ctx2.textAlign = 'left';
                ctx2.fillText('After ticks:', boxX + 30, boxY + 255);
                ctx2.fillStyle = '#ffffff';
                ctx2.textAlign = 'right';
                ctx2.fillText(afterCount.toLocaleString(), boxX + 470, boxY + 255);
              }

              // Legend (Drawn at the far bottom-left, completely off the map bounding area)
              ctx2.textAlign = 'left';
              ctx2.fillStyle = '#94a3b8';
              ctx2.font = '600 18px system-ui, -apple-system, sans-serif';
              ctx2.fillText('HEATMAP SCALE', 100, 1490);

              // Draw gradient bar
              const grad = ctx2.createLinearGradient(100, 0, 420, 0);
              grad.addColorStop(0, 'hsl(55, 100%, 65%)');
              grad.addColorStop(0.5, 'hsl(28, 100%, 55%)');
              grad.addColorStop(1, 'hsl(0, 100%, 48%)');
              ctx2.fillStyle = grad;
              ctx2.fillRect(100, 1510, 320, 16);

              // Draw legend labels
              ctx2.fillStyle = '#94a3b8';
              ctx2.font = '700 20px system-ui, -apple-system, sans-serif';
              ctx2.textAlign = 'right';
              ctx2.fillText('0', 80, 1525);
              ctx2.textAlign = 'left';
              ctx2.fillText(maxVal, 435, 1525);
            } else {
              // Draw plain map centered and filling almost the entire canvas
              ctx2.drawImage(img, 60, 48, 1880, 1504);
              URL.revokeObjectURL(url);
            }

            // Export trigger
            const link = document.createElement('a');
            document.body.appendChild(link);
            link.download = constructDescriptiveFilename('png');
            link.href = canvas.toDataURL('image/png');
            link.click();
            document.body.removeChild(link);
            showToast('Map image downloaded!', 'success');
          } catch (securityError) {
            console.warn('Canvas export tainted or restricted, falling back to SVG download:', securityError);
            triggerDirectSvgDownload(svgData);
          }
        };
 
        img.onerror = (err) => {
          console.warn('Failed to load SVG into image, falling back to direct SVG download:', err);
          triggerDirectSvgDownload(svgData);
        };
 
        img.src = url;
      });
    }
 
    function constructDescriptiveFilename(extension) {
      const levelStr = DOM.tickLevel && DOM.tickLevel.value === 'state' ? 'state-level' : 'county-level';
      
      let geoStr = 'us';
      if (state.filterState) {
        const cleanState = cleanStateCode(state.filterState).toLowerCase();
        geoStr = cleanState;
        const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';
        if (!isStateLevel && state.selectedMapCounty) {
          const cleanCounty = state.selectedMapCounty.toLowerCase().replace(/[^a-z0-9]/g, '-');
          geoStr = `${cleanState}-${cleanCounty}-county`;
        }
      }

      const colorMode = DOM.mapColorMode ? DOM.mapColorMode.value : 'total';
      const modeStr = colorMode === 'added' ? 'timeframe-additions' : 'lifetime-totals';

      let timeframeStr = 'all-time';
      if (state.tickDateStart || state.tickDateEnd) {
        const startVal = state.tickDateStart ? state.tickDateStart : 'start';
        const endVal = state.tickDateEnd ? state.tickDateEnd : 'present';
        timeframeStr = `${startVal}_to_${endVal}`;
      }

      const exportInfographic = DOM.toggleExportInfographic ? DOM.toggleExportInfographic.checked : true;
      const suffixStr = exportInfographic ? 'infographic' : 'plain';

      return `birding-tracker-${levelStr}-${geoStr}-${modeStr}-${timeframeStr}-${suffixStr}.${extension}`;
    }

    function triggerDirectSvgDownload(svgData) {
      const link = document.createElement('a');
      document.body.appendChild(link);
      link.download = constructDescriptiveFilename('svg');
      link.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
      link.click();
      document.body.removeChild(link);
      showToast('Browser security restricted PNG; downloaded SVG map instead!', 'warning');
    }

    // Download table as CSV
    if (DOM.btnDownloadCsv) {
      DOM.btnDownloadCsv.addEventListener('click', () => {
        const rows = DOM.subregionListBody.querySelectorAll('tr');
        if (rows.length === 0) {
          showToast('No data to export.', 'warning');
          return;
        }

        const isTimeframeActive = !!(state.tickDateStart || state.tickDateEnd);
        const isStateLevel = DOM.tickLevel && DOM.tickLevel.value === 'state';
        let headers = isStateLevel ? ['State', 'Country', 'Total Ticks'] : ['County', 'State', 'Total Ticks'];
        if (isTimeframeActive) {
          headers.push('Timeframe Start', 'Timeframe End', 'Added');
        }

        const csvRows = [headers.join(',')];
        rows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          const rowData = [];
          cells.forEach(td => {
            let val = td.textContent.trim();
            if (val.includes(',')) val = `"${val}"`;
            rowData.push(val);
          });
          csvRows.push(rowData.join(','));
        });

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        document.body.appendChild(link);
        link.download = 'birding-tracker-subregions.csv';
        link.href = URL.createObjectURL(blob);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        showToast('CSV exported!', 'success');
      });
    }

    // Custom Exclusion Form Submit
    if (DOM.formAddExclusion) {
      DOM.formAddExclusion.addEventListener('submit', handleAddExclusion);
    }

    // Dependent exclusion county dropdown populator
    if (DOM.exclusionState) {
      DOM.exclusionState.addEventListener('change', () => {
        const selectedState = DOM.exclusionState.value;
        if (!selectedState) {
          DOM.exclusionCounty.innerHTML = '<option value="">All Counties</option>';
          return;
        }
        const counties = [...new Set(state.regions
          .filter(r => r.state === selectedState)
          .map(r => r.county)
        )].filter(Boolean).sort();

        DOM.exclusionCounty.innerHTML = '<option value="">All Counties</option>';
        for (const c of counties) {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          DOM.exclusionCounty.appendChild(opt);
        }
      });
    }
  }

  function clearQuickPickActive() {
    document.querySelectorAll('.quick-pick-btn').forEach(b => b.classList.remove('is-active'));
  }

  /* -----------------------------------------------------------------------
     16. Boot
     ----------------------------------------------------------------------- */

  function boot() {
    state.simDate = new Date();
    DOM.filterSimDate.value = formatDateISO(state.simDate);
    state.targetYear = new Date().getFullYear();
    bindEvents();
    state.aggregateSubspecies = DOM.toggleAggregate.checked;
    state.showTrueSpeciesOnly = DOM.toggleTrueSpecies.checked;

    // Default timeframe to "This Year"
    const today = new Date();
    const yearStart = new Date(today.getFullYear(), 0, 1);
    state.tickDateStart = formatDateISO(yearStart);
    state.tickDateEnd = formatDateISO(today);
    DOM.tickDateStart.value = state.tickDateStart;
    DOM.tickDateEnd.value = state.tickDateEnd;
    const thisYearBtn = document.querySelector('.quick-pick-btn[data-preset="this-year"]');
    if (thisYearBtn) thisYearBtn.classList.add('is-active');

    initDashboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
