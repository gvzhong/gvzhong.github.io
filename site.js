/**
 * site.js — Data-driven page renderer.
 * Loads data/site.yaml (and data/cve.yaml for the CVE preview) and
 * populates every section of index.html.
 * To add or edit content, only the YAML files need to change.
 */

document.addEventListener('DOMContentLoaded', async function () {
  const siteYaml = await fetch('data/site.yaml').then(r => r.text());
  const data = jsyaml.load(siteYaml);

  renderProfile(data.profile);
  renderNews(data.news);
  renderPublications(data.publications);
  renderTalks(data.talks);
  renderCTF(data.ctf);
  renderHonors(data.honors);
  renderExperiences(data.experiences);
  renderServices(data.services);
  wireNewsToggle();

  // cve.yaml is gitignored locally; load only when available
  fetch('data/cve.yaml')
    .then(r => { if (!r.ok) throw new Error('cve.yaml not found'); return r.text(); })
    .then(yaml => renderCVEPreview(jsyaml.load(yaml).cves, 8))
    .catch(() => {});

  fetch('data/vendor-collaborations.yaml')
    .then(r => { if (!r.ok) throw new Error('vendor-collaborations.yaml not found'); return r.text(); })
    .then(yaml => renderVendorCollaborations(jsyaml.load(yaml).vendors))
    .catch(() => {});
});

// ── Helpers ────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (html) e.innerHTML = html;
  return e;
}

function entryLinks(links) {
  return links
    .map(l => `<a href="${l.url}">${l.label}</a>`)
    .join(' / ');
}

// ── Section renderers ──────────────────────────────────────────────────────

function renderProfile(profile) {
  const img = document.querySelector('#profile-photo');
  const bio = document.querySelector('#profile-bio');
  const links = document.querySelector('#profile-links');
  if (!img || !bio || !links) return;

  img.src = profile.photo;
  img.alt = profile.name;

  bio.querySelector('h1').textContent = profile.name;
  const bioContainer = bio.querySelector('.bio-paragraphs');
  profile.bio.forEach(text => {
    bioContainer.appendChild(el('p', {}, text));
  });

  profile.links.forEach((link, i) => {
    if (i > 0) links.appendChild(document.createTextNode('\u00a0/\u00a0'));
    const a = el('a', { href: link.url }, link.label);
    if (link.onclick) a.setAttribute('onclick', link.onclick);
    links.appendChild(a);
  });
}

function renderNews(items) {
  const visible = document.querySelector('#news-visible');
  const collapsed = document.querySelector('#news-collapsed');
  if (!visible || !collapsed) return;

  items.forEach((item, i) => {
    const node = el('div', { class: 'timeline-item' }, `
      <div class="timeline-dot"></div>
      <div class="timeline-date">${item.date}</div>
      <div class="timeline-text">${item.text}</div>
    `);
    (i === 0 ? visible : collapsed).appendChild(node);
  });
}

function renderPublications(pubs) {
  const container = document.querySelector('#publications-list');
  if (!container) return;

  pubs.forEach(pub => {
    const authorsHtml = pub.authors ? `<br>${pub.authors}<br>` : '';
    const linksHtml = entryLinks(pub.links);
    const featuredHtml = pub.featured_by
      ? `<span class="featured-by">
           <span class="featured-by-bullet">&#9632;</span>
           <span class="featured-by-text">Featured by: ${
             pub.featured_by.map(f => `<a href="${f.url}" target="_blank" rel="noopener noreferrer">${f.label}</a>`).join(', ')
           }, and other international outlets.</span>
         </span>`
      : '';
    container.innerHTML += `
      <table class="section-table">
        <tr>
          <td class="entry-cell">
            <h3>${pub.title}</h3>
            ${authorsHtml}
            ${linksHtml}
            <br>
            <em>${pub.venue}</em>
            ${featuredHtml}
            <p></p>
          </td>
        </tr>
      </table>`;
  });
}

function renderTalks(talks) {
  const container = document.querySelector('#talks-list');
  if (!container) return;

  // Speaker talks first, then contributor/other; order preserved within each group.
  const speakerFirst = t => (/^\s*speaker/i.test(t.venue || '') ? 0 : 1);
  const ordered = [...talks].sort((a, b) => speakerFirst(a) - speakerFirst(b));

  ordered.forEach(talk => {
    const linksHtml = entryLinks(talk.links);
    container.innerHTML += `
      <table class="section-table">
        <tr>
          <td class="talk-cell">
            <h3>${talk.title}</h3>
            <br>
            <em>${talk.venue}</em>
            <br>
            ${linksHtml}
            <br>
          </td>
        </tr>
      </table>`;
  });
}

function renderCTF(ctf) {
  const tbody = document.querySelector('#ctf-tbody');
  if (!tbody) return;

  ctf.entries.forEach(entry => {
    tbody.innerHTML += `
      <tr>
        <td style="white-space:nowrap; padding-bottom:10px;">
          Team member @ ${entry.team}<br>
          <span style="font-weight:normal;">${entry.description}</span>
        </td>
        <td class="date-cell"><em>${entry.period}</em></td>
      </tr>`;
  });
}

function renderHonors(honors) {
  const tbody = document.querySelector('#honors-tbody');
  if (!tbody || !honors) return;

  honors.forEach(h => {
    const org = h.org ? `, ${h.org}` : '';
    tbody.innerHTML += `
      <tr>
        <td>${h.title}${org}</td>
        <td><em>${h.period || ''}</em> &emsp;</td>
      </tr>`;
  });
}

function renderExperiences(experiences) {
  const tbody = document.querySelector('#experiences-tbody');
  if (!tbody) return;

  experiences.forEach(exp => {
    tbody.innerHTML += `
      <tr>
        <td>${exp.role}</td>
        <td><em>${exp.period}</em> &emsp;</td>
      </tr>`;
  });
}

function renderServices(services) {
  const tbody = document.querySelector('#services-tbody');
  if (!tbody) return;

  services.forEach(svc => {
    const itemsHtml = svc.items.map(i => `<p style="margin:0;">${i}</p>`).join('');
    tbody.innerHTML += `
      <tr>
        <td>${svc.role}</td>
        <td>${itemsHtml}</td>
      </tr>`;
  });
}

function wireNewsToggle() {
  var btn = document.getElementById('timeline-toggle');
  var collapsed = document.getElementById('news-collapsed');
  if (!btn || !collapsed) return;
  btn.addEventListener('click', function () {
    var expanded = collapsed.style.display !== 'none';
    collapsed.style.display = expanded ? 'none' : 'block';
    btn.textContent = expanded ? '⋯ more' : '⋯ less';
  });
}

function listToSentence(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function renderVendorCollaborations(vendors) {
  const note = document.querySelector('#vendor-collab-note');
  if (!note || !vendors) return;

  const recsOf = v => (v.findings || []).map(f => f.recognition).filter(Boolean);
  const hasRec = (v, re) => recsOf(v).some(r => re.test(r));

  // Sort by prominence (rank); unranked vendors fall to the end.
  const ordered = [...vendors].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  // Company favicon (data-driven via `domain`); recognized companies are bolded.
  const icon = v => v.domain
    ? `<img class="company-icon" src="https://www.google.com/s2/favicons?sz=64&domain=${v.domain}" alt="" loading="lazy">`
    : '';
  const nameHtml = ordered.map(v => {
    const label = recsOf(v).length ? `<strong>${v.name}</strong>` : v.name;
    return `<span class="company"> ${icon(v)}${label}</span>`;
  });
  let html = `<p class="cve-description">Companies I have collaborated with directly include ${listToSentence(nameHtml)}.</p>`;

  // Recognition paragraph: security halls of fame + MSRC-style leaderboards.
  const hof = ordered.filter(v => hasRec(v, /hall of fame/i)).map(v => v.name);
  const boards = [];
  ordered.forEach(v => recsOf(v).forEach(r => {
    if (/leaderboard/i.test(r)) boards.push(`${v.name}'s ${r.replace(/;\s*/g, ' and ')}`);
  }));

  const recs = [];
  if (hof.length) recs.push(`security halls of fame at ${listToSentence(hof)}`);
  if (boards.length) recs.push(listToSentence(boards));
  if (recs.length) {
    html += `<p class="cve-description">Several of these disclosures earned formal recognition, including ${recs.join(', as well as ')}.</p>`;
  }
  note.innerHTML = html;
}

function renderCVEPreview(cves, limit) {
  const table = document.querySelector('#cve-table');
  if (!table) return;

  cves.slice(0, limit).forEach(cve => {
    table.innerHTML += `
      <tr>
        <td><a href="${cve.url}">${cve.id}</a></td>
        <td><a href="${cve.product_url}">${cve.product}</a></td>
        <td>${cve.type}</td>
      </tr>`;
  });
}
