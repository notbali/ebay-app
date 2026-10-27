function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ============================================================
// Hero voyage — several ships crossing the hero on their own dashed
// routes (same offset-path + marching-dash mechanic as the app's
// voyage-map widget), scaled up and layered for a sense of depth.
// ============================================================
// Lanes are placed to cross the negative space around the hero copy (above the
// eyebrow, below the buttons) plus one prominent lane through the bold headline
// itself, which stays legible under a crossing ship the way the smaller body
// text does not - so the busier lane is routed to avoid the paragraph band.
const HERO_LANES = [
  { d: 'M-40 70 C 220 30, 480 110, 1240 60', scale: 0.55, opacity: 0.28, duration: 26, delay: -4 },
  { d: 'M-40 440 C 260 480, 520 400, 1240 460', scale: 0.8, opacity: 0.5, duration: 20, delay: -11 },
  { d: 'M-40 210 C 300 160, 560 260, 1240 200', scale: 1.1, opacity: 0.75, duration: 15, delay: -2 },
];

function buildHeroVoyage() {
  const lanes = HERO_LANES.map((lane, i) => `
    <path class="hero-route" style="opacity:${lane.opacity * 0.7}" d="${lane.d}" />
    <g class="hero-ship-group" style="offset-path: path('${lane.d}'); opacity:${lane.opacity}; --hero-scale:${lane.scale}; --hero-dur:${lane.duration}s; --hero-delay:${lane.delay}s;" data-lane="${i}">
      <g class="hero-ship" transform="translate(-66,-54)">
        <path d="M0 72 L132 72 L108 102 L24 102 Z" />
        <path class="hero-ship-sail" d="M66 12 L66 72 L12 72 Z" />
      </g>
    </g>
  `).join('');

  return `
    <svg class="hero-voyage-svg" viewBox="0 0 1200 500" preserveAspectRatio="xMidYMid meet" role="presentation" focusable="false">
      ${lanes}
    </svg>
  `;
}

function initHeroVoyage() {
  const mount = document.getElementById('hero-voyage');
  if (!mount) return;
  mount.innerHTML = buildHeroVoyage();
  if (prefersReducedMotion()) {
    mount.querySelectorAll('.hero-ship-group').forEach((g) => { g.style.offsetDistance = '35%'; });
  }
}

// Fades+lifts persistent headings in once when they first enter the viewport.
function initHeadingReveal() {
  const els = document.querySelectorAll('.reveal-on-load');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.15 });
  els.forEach((el) => observer.observe(el));
}

initHeroVoyage();
initHeadingReveal();
