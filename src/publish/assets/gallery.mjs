// @ts-check
/**
 * The gallery's language filter (DESIGN §11.2), copied to `site/assets/gallery.mjs`. Progressive
 * enhancement: without this script every pick is listed and the per-language feeds still work.
 * It builds its buttons with `createElement` and `textContent` only, keeps the chosen language in
 * the URL hash (`#lang=rust`), and makes no network requests.
 */

/**
 * The language family named in a URL hash such as `#lang=rust`, or null.
 * @param {string} hash
 * @returns {string | null}
 */
export function langFromHash(hash) {
  const m = /(?:^#|&)lang=([a-z0-9-]+)/.exec(String(hash));
  return m ? m[1] : null;
}

/**
 * Build the filter buttons above the cards and wire them up. Does nothing when the page has fewer
 * than two language families.
 * @param {Document} doc
 * @returns {void}
 */
export function initFilters(doc) {
  const nav = doc.querySelector('nav.filters');
  const cards = [...doc.querySelectorAll('li.card[data-family]')].map((c) => /** @type {HTMLElement} */ (c));
  if (!nav || cards.length === 0) return;

  /** @type {Map<string, {label: string, count: number}>} */
  const families = new Map();
  for (const card of cards) {
    const slug = card.getAttribute('data-family') ?? 'other';
    const label = card.getAttribute('data-family-label') || slug;
    const f = families.get(slug) ?? { label, count: 0 };
    f.count++;
    families.set(slug, f);
  }
  if (families.size < 2) return;

  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  /** @param {string | null} slug */
  const apply = (slug) => {
    for (const card of cards) card.hidden = slug !== null && card.getAttribute('data-family') !== slug;
    for (const b of buttons) b.setAttribute('aria-pressed', String((b.dataset.family ?? null) === slug));
  };
  /**
   * @param {string | null} slug
   * @param {string} text
   */
  const add = (slug, text) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (slug) b.dataset.family = slug;
    b.addEventListener('click', () => {
      const url = slug ? `#lang=${slug}` : `${location.pathname}${location.search}`;
      history.replaceState(null, '', url);
      apply(slug);
    });
    nav.append(b);
    buttons.push(b);
  };

  add(null, `All (${cards.length})`);
  const sorted = [...families]
    .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
  for (const [slug, f] of sorted) add(slug, `${f.label} (${f.count})`);
  /** @type {HTMLElement} */ (nav).hidden = false;

  const pick = () => {
    const slug = langFromHash(location.hash);
    apply(slug && families.has(slug) ? slug : null);
  };
  pick();
  window.addEventListener('hashchange', pick);
}

if (typeof document !== 'undefined') initFilters(document);
