/* ==========================================================================
   worker.js — Background Web Worker for eBird CSV / ZIP Parsing
   
   This worker is loaded as inline code via a Blob URL from app.js.
   It uses PapaParse (loaded via importScripts from CDN) and JSZip
   for in-browser decompression and parsing.
   ========================================================================== */

/* global importScripts, Papa, JSZip */

importScripts(
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
);

/**
 * Convert an eBird date string (YYYY-MM-DD) into a day-of-year integer (1-366).
 */
function dateToDayOfYear(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  const oneDay = 86400000;
  return Math.floor(diff / oneDay);
}

/**
 * Process a raw CSV text string from an eBird export.
 * Posts back progress and final parsed records.
 */
function parseCSV(csvText) {
  const results = [];
  let rowCount = 0;
  let totalEstimate = 0;

  // Estimate total rows for progress reporting
  const lineBreaks = csvText.split('\n').length;
  totalEstimate = lineBreaks - 1; // minus header

  self.postMessage({ type: 'progress', phase: 'parsing', current: 0, total: totalEstimate });

  Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    step: function (row) {
      rowCount++;
      const d = row.data;

      // eBird CSV columns (standard My eBird Data export)
      const submissionId = d['Submission ID'] || '';
      const commonName = (d['Common Name'] || '').trim();
      const scientificName = (d['Scientific Name'] || '').trim();
      const taxonomicOrder = parseInt(d['Taxonomic Order'], 10) || 0;
      const countRaw = d['Count'] || '0';
      const count = countRaw === 'X' ? 1 : parseInt(countRaw, 10) || 0;
      const state = (d['State/Province'] || '').trim();
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

      if (!commonName || !dateStr) return; // skip malformed rows

      const yearNum = parseInt(dateStr.substring(0, 4), 10);
      const dayOfYear = dateToDayOfYear(dateStr);

      // Unique composite key
      const id = submissionId + '::' + commonName;

      results.push({
        id,
        submissionId,
        commonName,
        scientificName,
        taxonomicOrder,
        count,
        state,
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

      // Report progress every 5000 rows
      if (rowCount % 5000 === 0) {
        self.postMessage({
          type: 'progress',
          phase: 'parsing',
          current: rowCount,
          total: totalEstimate,
        });
      }
    },
    complete: function () {
      self.postMessage({
        type: 'progress',
        phase: 'storing',
        current: rowCount,
        total: totalEstimate,
      });

      // Send records in batches
      const BATCH_SIZE = 10000;
      for (let i = 0; i < results.length; i += BATCH_SIZE) {
        const batch = results.slice(i, i + BATCH_SIZE);
        self.postMessage({
          type: 'batch',
          records: batch,
          batchIndex: Math.floor(i / BATCH_SIZE),
          totalBatches: Math.ceil(results.length / BATCH_SIZE),
        });
      }

      self.postMessage({
        type: 'complete',
        totalRecords: results.length,
      });
    },
    error: function (error) {
      self.postMessage({ type: 'error', message: error.message || 'CSV parse error' });
    },
  });
}

/**
 * Handle incoming file data from the main thread.
 */
self.onmessage = async function (e) {
  const { type, data, fileName } = e.data;

  try {
    if (type === 'parse-csv') {
      // data is a string (CSV text)
      parseCSV(data);
    } else if (type === 'parse-zip') {
      // data is an ArrayBuffer of the ZIP file
      self.postMessage({ type: 'progress', phase: 'unzipping', current: 0, total: 1 });

      const zip = await JSZip.loadAsync(data);
      const csvFiles = Object.keys(zip.files).filter(
        (name) => name.toLowerCase().endsWith('.csv') && !name.startsWith('__MACOSX')
      );

      if (csvFiles.length === 0) {
        self.postMessage({ type: 'error', message: 'No CSV file found inside the ZIP archive.' });
        return;
      }

      // Use the first (or largest) CSV file found
      const csvFileName = csvFiles[0];
      self.postMessage({
        type: 'progress',
        phase: 'unzipping',
        current: 1,
        total: 1,
        detail: csvFileName,
      });

      const csvText = await zip.files[csvFileName].async('string');
      parseCSV(csvText);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || 'Worker error' });
  }
};
