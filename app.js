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

  /* -----------------------------------------------------------------------
     1. State
     ----------------------------------------------------------------------- */
  const state = {
    observations: [],        // All observations for current filter
    speciesData: [],         // Computed species grid data
    targets: new Map(),      // commonName -> { isTarget, addedAt }
    regions: [],             // [{state, county}]
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

    // Slashes
    if (c.includes('/') || s.includes('/')) return false;

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

  /** Convert a date string (YYYY-MM-DD) to day-of-year. */
  function dateStrToDayOfYear(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
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
            const submissionId = d['Submission ID'] || '';
            const commonName = (d['Common Name'] || '').trim();
            const scientificName = (d['Scientific Name'] || '').trim();
            const taxonomicOrder = parseInt(d['Taxonomic Order'], 10) || 0;
            const countRaw = d['Count'] || '0';
            const count = countRaw === 'X' ? 1 : parseInt(countRaw, 10) || 0;
            const stateVal = (d['State/Province'] || '').trim();
            const county = (d['County'] || '').trim();
            const locationId = (d['Location ID'] || '').trim();
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

            const yearNum = parseInt(dateStr.substring(0, 4), 10);
            const dayOfYear = dateStrToDayOfYear(dateStr);
            const id = submissionId + '::' + commonName;

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
              date: dateStr,
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

  /* -----------------------------------------------------------------------
     8. Mock Data Generator
     ----------------------------------------------------------------------- */

  function generateMockData() {
    showLoading('Generating mock eBird data...');

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

    DB.putObservations(records).then(() => {
      hideLoading();
      showToast(`Generated ${records.length.toLocaleString()} mock observations across ${YEARS.length} years!`, 'success');
      initDashboard();
    }).catch(err => {
      hideLoading();
      showToast('Error storing mock data: ' + err.message, 'error');
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

      const totalRecords = await DB.countObservations();
      DOM.statTotalRecords.textContent = totalRecords.toLocaleString();
      state.isDataLoaded = totalRecords > 0;

      if (state.isDataLoaded) {
        DOM.emptyState.style.display = 'none';
        DOM.gridWrapper.style.display = 'block';
        DOM.statsBar.style.display = 'flex';
        await refreshGrid();
      } else {
        DOM.emptyState.style.display = 'flex';
        DOM.gridWrapper.style.display = 'none';
        DOM.statsBar.style.display = 'none';
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
      a.href = url;
      a.download = `ebird-tracker-state-${formatDateISO(new Date())}.json`;
      a.click();
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
      DOM.emptyState.style.display = 'flex';
      DOM.gridWrapper.style.display = 'none';
      DOM.statsBar.style.display = 'none';
      DOM.alertsPanel.classList.remove('is-open');
      DOM.importProgress.style.display = 'none';
      DOM.importStatus.style.display = 'none';
      DOM.statTotalRecords.textContent = '0';
      DOM.statTotalSpecies.textContent = '0';
      showToast('All data cleared.', 'warning');
    } catch (err) {
      showToast('Clear error: ' + err.message, 'error');
    }
  }

  /* -----------------------------------------------------------------------
     15. Event Binding
     ----------------------------------------------------------------------- */

  function bindEvents() {
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
      populateCountyFilter();
      DB.setSetting('filterState', state.filterState);
      DB.setSetting('filterCounty', '');
      if (state.isDataLoaded) refreshGrid();
    });

    DOM.filterCounty.addEventListener('change', (e) => {
      state.filterCounty = e.target.value;
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
    initDashboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
