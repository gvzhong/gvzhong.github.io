/**
 * @fileoverview Renders the "Some Things I Hacked (and Helped Mitigate)" list
 * on cves.html from data/vendor-collaborations.yaml.
 *
 * Findings with a `cve` are skipped; the CVE table on the same page covers
 * them. Every other finding is listed as "YEAR - <b>label</b> impact", newest
 * year first
 * and, within a year, by vendor `rank`. Findings sharing the same year and
 * impact text are merged into one line ("<b>A</b>, <b>B</b> impact"). Undated
 * findings go last without a year.
 *
 * A recognition tag links to the finding's `recognition_url` when one is set;
 * the link keeps the tag's plain look. Only http(s) URLs are used.
 *
 * Text is inserted with textContent, never innerHTML, so YAML content cannot
 * inject markup. The pure helpers are exported for Node-based tests.
 */

'use strict';

/** Source of truth for vendor findings. */
const HACKED_DATA_URL = 'data/vendor-collaborations.yaml';

/** Recognition strings short enough to show next to a one-line finding. */
const HACKED_RECOGNITION_PATTERN = /hall of fame|acknowledg/i;

/**
 * Extracts the report year from a finding's `date` field.
 *
 * Accepts "YYYY-MM-DD", "YYYY" (string or number), or a Date (js-yaml turns
 * unquoted ISO dates into Date objects). Anything else counts as unknown.
 *
 * @param {*} value Raw `date` value from YAML.
 * @return {?number} Four-digit year, or null if missing or unrecognized.
 */
function parseReportYear(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getUTCFullYear();
  }
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (match[2]) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Reject impossible dates such as 2025-02-30, which Date would roll over.
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return null;
    }
  }
  return year;
}

/**
 * Returns the trimmed string, or '' for anything that is not a string.
 * @param {*} value
 * @return {string}
 */
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns the URL if it is an absolute http(s) URL, otherwise ''.
 *
 * Blocks javascript:, data:, and relative URLs so a typo or a bad value in the
 * YAML cannot turn a recognition tag into a script link.
 *
 * @param {*} value Raw `recognition_url` value from YAML.
 * @return {string}
 */
function safeHttpUrl(value) {
  const text = cleanText(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (error) {
    return '';  // Not an absolute URL.
  }
}

/**
 * A recognition tag; `url` is '' when the tag has no link.
 * @typedef {{text: string, url: string}}
 */
let HackedRecognition;

/**
 * One line of the rendered list.
 * @typedef {{
 *   labels: !Array<string>,
 *   impact: string,
 *   year: ?number,
 *   recognitions: !Array<!HackedRecognition>,
 *   rank: number,
 * }}
 */
let HackedRow;

/**
 * Builds the list lines: newest year first, then by vendor prominence (rank),
 * undated last; same-year findings with identical impact text are merged.
 *
 * @param {?Array<!Object>} vendors Parsed `vendors` list.
 * @return {!Array<!HackedRow>}
 */
function collectHackedRows(vendors) {
  const rows = [];
  (vendors || []).forEach((vendor) => {
    const rank = Number.isFinite(vendor.rank) ? vendor.rank : 999;
    (vendor.findings || []).forEach((finding) => {
      if (cleanText(finding.cve)) return;  // Shown in the CVE table instead.
      const impact = cleanText(finding.impact) || cleanText(finding.title);
      const label = cleanText(finding.label) || cleanText(vendor.name);
      if (!impact || !label) return;
      const recognition = cleanText(finding.recognition);
      rows.push({
        labels: [label],
        impact,
        year: parseReportYear(finding.date),
        recognitions: HACKED_RECOGNITION_PATTERN.test(recognition) ?
            [{
              text: recognition.replace(/;\s*/g, ' & '),
              url: safeHttpUrl(finding.recognition_url),
            }] :
            [],
        rank,
      });
    });
  });

  rows.sort((a, b) => {
    const yearA = a.year === null ? -Infinity : a.year;
    const yearB = b.year === null ? -Infinity : b.year;
    return yearA !== yearB ? yearB - yearA : a.rank - b.rank;
  });

  // Merge after sorting so each merged line keeps its best-ranked position.
  const merged = [];
  const byKey = new Map();
  rows.forEach((row) => {
    const key = `${row.year}\u0000${row.impact}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      merged.push(row);
      return;
    }
    row.labels.forEach((l) => {
      if (!existing.labels.includes(l)) existing.labels.push(l);
    });
    row.recognitions.forEach((r) => {
      const same = existing.recognitions.find((e) => e.text === r.text);
      if (!same) {
        existing.recognitions.push(r);
      } else if (!same.url) {
        same.url = r.url;  // Keep a link if any merged finding has one.
      }
    });
  });
  return merged;
}

/**
 * Builds the list item for one line.
 * @param {!HackedRow} row
 * @return {!HTMLLIElement}
 */
function buildHackedItem(row) {
  const li = document.createElement('li');
  if (row.year !== null) {
    li.appendChild(document.createTextNode(`${row.year} - `));
  }
  row.labels.forEach((label, i) => {
    if (i > 0) li.appendChild(document.createTextNode(', '));
    const name = document.createElement('strong');
    name.textContent = label;
    li.appendChild(name);
  });
  li.appendChild(document.createTextNode(' ' + row.impact));
  row.recognitions.forEach(({text, url}) => {
    const rec = document.createElement('em');
    rec.className = 'hacked-recognition';
    rec.textContent = text;
    li.appendChild(document.createTextNode(' '));
    if (!url) {
      li.appendChild(rec);
      return;
    }
    const link = document.createElement('a');
    link.className = 'hacked-recognition-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(rec);
    li.appendChild(link);
  });
  return li;
}

/**
 * Shows a single message line in place of the list.
 * @param {!HTMLElement} list
 * @param {string} message
 */
function showHackedMessage(list, message) {
  const li = document.createElement('li');
  li.textContent = message;
  list.replaceChildren(li);
}

/** Fetches the vendor data and fills #hacked-list. */
async function loadHackedList() {
  const list = document.getElementById('hacked-list');
  if (!list) return;
  try {
    if (typeof jsyaml === 'undefined') {
      throw new Error('js-yaml failed to load');
    }
    const response = await fetch(HACKED_DATA_URL);
    if (!response.ok) {
      throw new Error(`${HACKED_DATA_URL}: HTTP ${response.status}`);
    }
    const data = jsyaml.load(await response.text());
    const rows = collectHackedRows(data && data.vendors);
    if (!rows.length) {
      showHackedMessage(list, 'Nothing to show yet.');
      return;
    }
    list.replaceChildren(...rows.map(buildHackedItem));
  } catch (error) {
    console.error('Error loading vendor findings:', error);
    showHackedMessage(list, 'Could not load this list. Please try again later.');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {collectHackedRows, parseReportYear, safeHttpUrl};
} else {
  document.addEventListener('DOMContentLoaded', loadHackedList);
}
