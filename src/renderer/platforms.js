'use strict';

// Platform rozetleri: marka rengi zemin üzerinde sade beyaz işaret (resmi logo değil, tanınır kısaltma).
// Renk ve adlar src/urls.js'teki PLATFORMS listesinden gelir.

const PLATFORM_GLYPHS = {
  youtube: '<rect x="3.5" y="6.5" width="17" height="11" rx="3.2" fill="none"/><path d="M10.5 9.6v4.8l4-2.4z" fill="currentColor" stroke="none"/>',
  instagram: '<rect x="4.5" y="4.5" width="15" height="15" rx="4.5" fill="none"/><circle cx="12" cy="12" r="3.4" fill="none"/><circle cx="16.6" cy="7.4" r=".9" fill="currentColor" stroke="none"/>',
  tiktok: '<path d="M13.5 4.5v10.2a3.3 3.3 0 1 1-3.3-3.3"/><path d="M13.5 4.5c.4 2.3 1.9 3.8 4.4 4"/>',
  x: '<path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5"/>',
  facebook: '<path d="M13.8 20V12.8h2.6l.4-3h-3V8c0-.9.3-1.5 1.6-1.5H17V3.9a21 21 0 0 0-2.3-.1c-2.3 0-3.9 1.4-3.9 4v2h-2.6v3h2.6V20"/>',
  vimeo: '<path d="M4.5 9c1.3-1.1 2.7-2.6 3.8-2.6 1.6 0 1.7 2.6 2.2 5 .5 2.3.9 3.4 1.5 3.4.6 0 2.4-2.6 3.1-4.9.5-1.6-.1-2.4-1.4-1.8.9-2.7 3.4-3.6 4.6-2.7 1.1.9.5 3.5-1.2 6-2.3 3.4-4.2 5.6-5.9 5.6-1.6 0-2.4-2.7-3.1-5.6-.5-2.1-.8-3.4-1.7-2.4"/>',
  dailymotion: '<path d="M15.5 4.5v15"/><circle cx="11.3" cy="14.7" r="4.4" fill="none"/>',
  twitch: '<path d="M5.5 4.5h13v9l-3.5 3.5h-3l-2.5 2.5V17h-4z" fill="none"/><path d="M11 8.5v3.5M15 8.5v3.5"/>',
  reddit: '<ellipse cx="12" cy="14" rx="6.8" ry="4.6" fill="none"/><path d="M12 9.4 13.2 4.8l3.3.8"/><circle cx="17.4" cy="5.8" r="1.1" fill="none"/><circle cx="9.6" cy="13.5" r=".8" fill="currentColor" stroke="none"/><circle cx="14.4" cy="13.5" r=".8" fill="currentColor" stroke="none"/>',
  soundcloud: '<path d="M10 17.5V9.3a5 5 0 0 1 8 2.9 2.7 2.7 0 0 1 .4 5.3zM7.5 17.5v-6M5 17.5v-4"/>',
  bilibili: '<rect x="4" y="7.5" width="16" height="11" rx="2.5" fill="none"/><path d="M8.5 4.5 10.5 7.5M15.5 4.5l-2 3M9 12v2M15 12v2"/>',
  bandcamp: '<path d="M8.5 7.5h11l-4 9h-11z" fill="none"/>',
  pinterest: '<path d="M11 13.6 9.4 20M9.8 15.4c-2.8-1.3-2.7-8.9 3.3-8.9 3.7 0 5.1 2.8 4.4 5.4-.7 2.4-2.5 3.6-4.1 2.9-1-.4-1.3-1.7-1-2.8"/>',
  linkedin: '<path d="M7 10.5V17M7 7.2v.1M11 17v-6.5M11 13.3c0-1.8 1.2-2.9 2.8-2.9s2.5 1 2.5 2.9V17"/>',
  tumblr: '<path d="M10.5 4.5v11c0 2.4 1.4 3.5 3.5 3.5h2M8 9h7"/>',
  archive: '<path d="M4.5 8h15M5.5 19h13M6.5 10.5v6M10 10.5v6M14 10.5v6M17.5 10.5v6M12 4.5 5 8h14z" fill="none"/>',
  peertube: '<path d="M7 4.5v7l5-3.5zM7 12.5v7l5-3.5zM12.5 8.5v7l5-3.5z" fill="currentColor" stroke="none"/>',
  generic: '<circle cx="12" cy="12" r="7.5" fill="none"/><path d="M4.5 12h15M12 4.5a11.5 11.5 0 0 1 0 15M12 4.5a11.5 11.5 0 0 0 0 15" fill="none"/>',
};

function platformMeta(id) {
  return URLS.platformById(id);
}

// Rozet: <span class="pf" style="--pf:#ff0033"><svg …/></span>
function platformBadge(id, { size = 22, title = true } = {}) {
  const p = platformMeta(id);
  const glyph = PLATFORM_GLYPHS[p.id] || PLATFORM_GLYPHS.generic;
  return `<span class="pf pf-${p.id}" style="--pf:${p.color};width:${size}px;height:${size}px"${title ? ` title="${esc(p.id === 'generic' ? t('pf.generic') : p.name)}"` : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}

const platformName = (id) => (platformMeta(id).id === 'generic' ? t('pf.generic') : platformMeta(id).name);
