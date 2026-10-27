const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guard rails for the "voyage manifest" design system: an aged-paper customs manifest look
// (ruled columns, iron-gall ink, rubber stamps) that stays readable. These tests encode both
// the readability bar (WCAG AA contrast, real web fonts loaded on every page) and the generic
// "AI slop" tells we're deliberately avoiding (gradient/glow buttons, glass panels, pill-shaped
// everything, heavy blurred shadows, indigo/purple, cursor-chasing effects, side-border
// callouts, emoji-as-icons). Plain regex over source files - no browser or CSS parser needed.

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const STYLES = stripComments(read('styles.css'));
const LANDING = stripComments(read('landing.css'));
const ALL_CSS = `${STYLES}\n${LANDING}`;
const HTML_PAGES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
const JS_FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js'));

// ---------- tiny CSS helpers ----------

// Index of the '}' matching the '{' at `open`, skipping braces inside quoted strings (data URIs).
function matchBrace(css, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) { if (c === quote && css[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('Unbalanced braces in CSS');
}

// Splits a declaration body into [prop, value] pairs, respecting parens and quotes.
function parseDeclarations(body) {
  const decls = [];
  let current = '';
  let depth = 0;
  let quote = null;
  const flush = () => {
    const idx = current.indexOf(':');
    if (idx > 0) decls.push([current.slice(0, idx).trim(), current.slice(idx + 1).trim()]);
    current = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { current += c; if (c === quote && body[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { flush(); continue; }
    current += c;
  }
  flush();
  return decls;
}

// Flat list of { prelude, selector, decls } for every style rule, recursing into @media/@supports.
function parseRules(css, atContext = '') {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();
    const close = matchBrace(css, open);
    const body = css.slice(open + 1, close);
    if (/^@(media|supports)/.test(prelude)) {
      rules.push(...parseRules(body, `${atContext} ${prelude}`.trim()));
    } else if (!prelude.startsWith('@')) {
      rules.push({ selector: prelude, atContext, decls: parseDeclarations(body) });
    }
    i = close + 1;
  }
  return rules;
}

const RULES = [...parseRules(STYLES), ...parseRules(LANDING)];
const allDecls = () => RULES.flatMap((r) => r.decls.map(([prop, value]) => ({ prop, value, rule: r })));

// ---------- theme token blocks ----------

const rulesFor = (css) => parseRules(css);
const styleRules = rulesFor(STYLES);
const tokensOf = (rule) => Object.fromEntries(rule.decls.filter(([p]) => p.startsWith('--')));

const lightRule = styleRules.find((r) => r.selector === ':root' && !r.atContext);
const darkMediaRule = styleRules.find((r) => r.selector === ':root:not([data-theme="light"])' && /prefers-color-scheme: dark/.test(r.atContext));
const darkExplicitRule = styleRules.find((r) => r.selector === ':root[data-theme="dark"]');

const light = tokensOf(lightRule);
const darkMedia = tokensOf(darkMediaRule);
const darkExplicit = tokensOf(darkExplicitRule);
const dark = { ...light, ...darkExplicit };

const isHex = (v) => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v);
const COLOR_TOKENS = Object.keys(light).filter((k) => isHex(light[k]));

// ---------- colour math ----------

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function hueAndSat(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  return { hue, sat };
}

// ---------- token structure ----------

describe('theme tokens', () => {
  test('defines the manifest tokens (paper surfaces, rules, grain, hand font, spacing scale)', () => {
    for (const name of ['--surface-deep', '--success', '--grain', '--font-hand', '--text-on-danger']) {
      assert.ok(name in light, `missing ${name} in :root`);
    }
    for (let i = 1; i <= 8; i++) assert.ok(`--space-${i}` in light, `missing --space-${i}`);
  });

  test('every colour token is re-declared for dark mode, in both dark blocks, with identical values', () => {
    assert.ok(COLOR_TOKENS.length >= 12, 'expected a real palette of hex colour tokens');
    for (const name of COLOR_TOKENS) {
      assert.ok(name in darkMedia, `${name} missing from the prefers-color-scheme dark block`);
      assert.ok(name in darkExplicit, `${name} missing from the [data-theme="dark"] block`);
      assert.equal(darkMedia[name], darkExplicit[name], `${name} differs between the two dark blocks`);
    }
  });

  test('spacing scale sits on a 4px grid and strictly increases', () => {
    let prev = 0;
    for (let i = 1; i <= 8; i++) {
      const value = light[`--space-${i}`];
      const m = /^([\d.]+)rem$/.exec(value);
      assert.ok(m, `--space-${i} should be in rem, got ${value}`);
      const rem = parseFloat(m[1]);
      assert.equal((rem * 16) % 4, 0, `--space-${i} (${value}) is off the 4px grid`);
      assert.ok(rem > prev, `--space-${i} must be larger than --space-${i - 1}`);
      prev = rem;
    }
  });
});

// ---------- readability ----------

describe('readability (WCAG AA, 4.5:1) in both themes', () => {
  const themes = { sunrise: light, sunset: dark };
  const textOnSurface = ['--text-heading', '--text-body', '--text-secondary', '--accent', '--danger-text', '--success'];

  for (const [themeName, t] of Object.entries(themes)) {
    test(`${themeName}: text tokens are readable on paper and on aged paper`, () => {
      for (const surface of ['--surface', '--surface-deep']) {
        for (const fg of textOnSurface) {
          const ratio = contrast(t[fg], t[surface]);
          assert.ok(ratio >= 4.5, `${fg} (${t[fg]}) on ${surface} (${t[surface]}) is ${ratio.toFixed(2)}:1`);
        }
      }
    });

    test(`${themeName}: heading and body text are readable on the desk background`, () => {
      for (const fg of ['--text-heading', '--text-body']) {
        const ratio = contrast(t[fg], t['--bg']);
        assert.ok(ratio >= 4.5, `${fg} on --bg is ${ratio.toFixed(2)}:1`);
      }
    });

    test(`${themeName}: button labels are readable on their fills`, () => {
      assert.ok(contrast(t['--text-on-accent'], t['--accent']) >= 4.5, 'text-on-accent on accent');
      assert.ok(contrast(t['--text-on-accent'], t['--accent-deep']) >= 4.5, 'text-on-accent on accent-deep');
      assert.ok(contrast(t['--text-on-danger'], t['--danger']) >= 4.5, 'text-on-danger on danger');
      assert.ok(contrast(t['--text-on-danger'], t['--danger-deep']) >= 4.5, 'text-on-danger on danger-deep');
    });

    test(`${themeName}: ruled lines and borders stay visible against paper (3:1 non-text)`, () => {
      const ratio = contrast(t['--border-strong'], t['--surface']);
      assert.ok(ratio >= 3, `--border-strong on --surface is ${ratio.toFixed(2)}:1`);
    });
  }
});

describe('typography', () => {
  const firstFamily = (stack) => stack.split(',')[0].trim().replace(/^["']|["']$/g, '');
  const GENERIC_UI_FONTS = /^(-apple-system|blinkmacsystemfont|system-ui|segoe ui|arial|helvetica|helvetica neue|inter|roboto|sans-serif|georgia|times new roman|times)$/i;
  const webFonts = ['--font-display', '--font-body', '--font-hand'].map((t) => firstFamily(light[t]));

  test('display, body and hand fonts are real web fonts, not default system UI fonts', () => {
    for (const family of webFonts) {
      assert.ok(!GENERIC_UI_FONTS.test(family), `"${family}" is a default/system font`);
    }
    assert.equal(new Set(webFonts).size, 3, 'display, body and hand should be three distinct typefaces');
  });

  test('every HTML page that uses styles.css loads every declared web font from Google Fonts', () => {
    const pages = HTML_PAGES.filter((f) => read(f).includes('styles.css'));
    assert.ok(pages.length >= 8, `expected all pages to share styles.css, found ${pages.length}`);
    for (const page of pages) {
      const html = read(page);
      const link = /fonts\.googleapis\.com\/css2\?[^"']+/.exec(html);
      assert.ok(link, `${page} has no Google Fonts link`);
      const decoded = decodeURIComponent(link[0]).replace(/\+/g, ' ');
      for (const family of webFonts) {
        assert.ok(decoded.includes(`family=${family}`), `${page} does not load "${family}"`);
      }
    }
  });

  // Period typefaces draw "1" like a capital I. Part numbers like 1756-OB16E are this app's
  // data, so figures must stay unambiguous: lining numerals in the body face, and counters
  // (which are pure numbers) never use the engraved display face.
  test('figures are lining numerals so part numbers stay unambiguous', () => {
    const body = RULES.find((r) => r.selector === 'body' && !r.atContext);
    const numeric = body.decls.find(([p]) => p === 'font-variant-numeric');
    assert.ok(numeric && numeric[1].includes('lining-nums'), 'body needs font-variant-numeric: lining-nums');
    for (const selector of ['.harbor-board-count', '.draft-card::before']) {
      const rule = RULES.find((r) => r.selector === selector && !r.atContext);
      const family = rule.decls.find(([p]) => p === 'font-family');
      assert.ok(!family || !family[1].includes('--font-display'), `${selector} must not use the display face for numbers`);
    }
  });

  test('body copy is set at a comfortable reading size (at least 17px)', () => {
    const body = RULES.find((r) => r.selector === 'body' && !r.atContext);
    const size = body.decls.find(([p]) => p === 'font-size');
    assert.ok(size, 'body needs an explicit font-size');
    const m = /^([\d.]+)(rem|px)$/.exec(size[1]);
    assert.ok(m, `unexpected body font-size ${size[1]}`);
    const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
    assert.ok(px >= 17, `body font-size is ${px}px`);
  });
});

// ---------- behaviour the layout relies on ----------

describe('hidden attribute', () => {
  // Author rules like `form { display: flex }` out-rank the browser's [hidden] default, which
  // left the signup form visible under the login form. One global rule keeps `hidden` honest.
  test('is never overridden by component display rules', () => {
    const rule = RULES.find((r) => r.selector === '[hidden]' && !r.atContext);
    assert.ok(rule, 'styles.css needs a global [hidden] rule');
    const display = rule.decls.find(([p]) => p === 'display');
    assert.ok(display && /^none\s*!important$/.test(display[1]), `got display: ${display && display[1]}`);
  });
});

// ---------- the paper ----------

describe('paper', () => {
  test('the page is a sheet of paper textured with a grain overlay, not a flat colour fill', () => {
    assert.match(light['--grain'], /url\(/);
    const body = RULES.find((r) => r.selector === 'body' && !r.atContext);
    const bg = body.decls.find(([p]) => p === 'background-image' || p === 'background');
    assert.ok(bg && bg[1].includes('var(--grain)'), 'body should layer var(--grain)');
  });

  test('pages do not carry the old drifting-wave background layer', () => {
    for (const page of HTML_PAGES) {
      assert.ok(!read(page).includes('water-bg'), `${page} still has the .water-bg decoration`);
    }
    assert.ok(!/\.water-bg/.test(ALL_CSS), 'CSS still styles .water-bg');
  });
});

// ---------- anti-slop guards ----------

describe('anti-slop guards', () => {
  test('no smooth gradients (repeating hairline rulings are fine)', () => {
    const offenders = allDecls().filter(({ value }) => /(?<!repeating-)(linear|radial|conic)-gradient\(/.test(value));
    assert.deepEqual(offenders.map((o) => `${o.rule.selector} { ${o.prop} }`), []);
  });

  test('no glassmorphism (backdrop-filter / blur filters)', () => {
    const offenders = allDecls().filter(({ prop, value }) => prop.includes('backdrop-filter') || (prop === 'filter' && /blur\(/.test(value)));
    assert.deepEqual(offenders.map((o) => `${o.rule.selector} { ${o.prop} }`), []);
  });

  test('corners are square-ish: radius is at most 4px (circles for seals/round tags are ok)', () => {
    const resolve = (v) => v.replace(/var\((--[\w-]+)\)/g, (_, name) => light[name] ?? 'NaN');
    const offenders = [];
    for (const { prop, value, rule } of allDecls()) {
      if (!/^border(-\w+)*-radius$/.test(prop)) continue;
      const resolved = resolve(value).trim();
      if (resolved === '50%' || resolved === '0') continue;
      for (const m of resolved.matchAll(/([\d.]+)(px|rem)/g)) {
        const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
        if (px > 4) offenders.push(`${rule.selector} { ${prop}: ${value} }`);
      }
    }
    assert.deepEqual(offenders, []);
    for (const token of ['--radius', '--radius-sm']) {
      assert.ok(parseFloat(light[token]) <= 4, `${token} is ${light[token]}`);
    }
  });

  test('shadows are tight (blur at most 8px) and never a coloured glow', () => {
    const offenders = [];
    const shadowDecls = allDecls().filter(({ prop }) => prop === 'box-shadow' || prop === 'text-shadow' || prop === '--shadow');
    for (const { prop, value, rule } of shadowDecls) {
      if (value === 'none') continue;
      // Split layers on top-level commas only.
      const layers = [];
      let depth = 0; let cur = '';
      for (const c of value) {
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += c;
      }
      layers.push(cur);
      for (const layer of layers) {
        const lengths = [...layer.replace(/(color-mix|rgba?|var)\([^)]*(\([^)]*\))?[^)]*\)/g, '').matchAll(/(-?[\d.]+)(px|rem)?(?=\s|$)/g)];
        const blur = lengths[2] ? parseFloat(lengths[2][1]) : 0;
        if (blur > 8) offenders.push(`${rule.selector} { ${prop} } blur ${blur}px`);
        if (blur > 0 && /var\(--(accent|danger)/.test(layer)) offenders.push(`${rule.selector} { ${prop} } coloured glow`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('no thick coloured side-border callouts (column hairlines up to 1px are fine)', () => {
    const offenders = allDecls()
      .filter(({ prop }) => /^border-(left|right|inline-start|inline-end)(-width)?$/.test(prop))
      .filter(({ value }) => {
        const m = /([\d.]+)px/.exec(value);
        return m && parseFloat(m[1]) >= 2;
      });
    assert.deepEqual(offenders.map((o) => `${o.rule.selector} { ${o.prop}: ${o.value} }`), []);
  });

  test('no purple/indigo anywhere in the palette (hue 240-300, saturated)', () => {
    const hexes = new Set([...Object.values(light), ...Object.values(darkExplicit)].filter(isHex));
    for (const m of ALL_CSS.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) hexes.add(m[0]);
    const offenders = [...hexes].filter((hex) => {
      const { hue, sat } = hueAndSat(hex);
      return hue >= 240 && hue <= 300 && sat > 0.12;
    });
    assert.deepEqual(offenders, []);
  });

  test('hovering never lifts or scales things (no floating cards)', () => {
    const offenders = allDecls()
      .filter(({ rule }) => rule.selector.includes(':hover'))
      .filter(({ prop, value }) => prop === 'transform' && /translateY\(-|scale\(1\.|translate\(/.test(value));
    assert.deepEqual(offenders.map((o) => o.rule.selector), []);
  });

  test('no cursor-chasing effects in page scripts', () => {
    const offenders = JS_FILES.filter((f) => /pointermove|mousemove/.test(read(f)));
    assert.deepEqual(offenders, []);
  });

  test('no emoji used as icons in markup or scripts', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const offenders = [...HTML_PAGES, ...JS_FILES].filter((f) => emoji.test(read(f)));
    assert.deepEqual(offenders, []);
  });

  test('every animation is covered by the reduced-motion override', () => {
    const reducedSelectors = RULES
      .filter((r) => /prefers-reduced-motion: reduce/.test(r.atContext) && r.decls.some(([p, v]) => p === 'animation' && v.startsWith('none')))
      .flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    const animated = RULES
      .filter((r) => !r.atContext.includes('prefers-reduced-motion') && r.decls.some(([p, v]) => p === 'animation' && v !== 'none'))
      .flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    // An override covers an animated selector if it names it, or a shorter form of it (a
    // `.x .y` override beats `.x .y.charted` through !important).
    const uncovered = animated.filter((sel) => !reducedSelectors.some((s) => sel === s || sel.startsWith(s)));
    assert.deepEqual(uncovered, []);
  });
});
