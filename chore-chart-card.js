/**
 * chore-chart-card.js
 *
 * A Home Assistant Lovelace custom card for tracking family chores.
 * Supports weekly, monthly, and one-time chores with a points-based
 * leaderboard, multi-person claim system, and last-week champion banner.
 *
 * State is stored in HA as `sensor.chore_chart_data` so all devices
 * stay in sync automatically via HA's own WebSocket connection.
 *
 * @version 1.0.0
 * @author  Benjamin Ellis
 * @license MIT
 *
 * Installation:
 *   1. Copy chore-chart-card.js to your HA config/www/ folder
 *   2. Add to your dashboard resources:
 *        url: /local/chore-chart-card.js
 *        type: module
 *   3. Add to a dashboard:
 *        type: custom:chore-chart-card
 *        title: Family Chores   (optional)
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Short day-of-week labels used throughout the UI */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Default avatar colors available when adding family members */
const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#e05a10',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f43f5e', '#6366f1'
];

/** Banner color presets — dark tones that look good on any HA theme */
const BANNER_PRESETS = [
  '#2c2a24', '#1e2a1e', '#1a1e2e', '#2a1a2e',
  '#1e1a0a', '#2e1a1a', '#1a2820', '#18160f',
  '#1e2030', '#292418'
];

/** HA entity used to persist all chore data across devices */
const STATE_ENTITY = 'sensor.chore_chart_data';

/** Empty starting state — used on first run */
const EMPTY_STATE = { people: [], chores: [], lastWinner: null };

// ─────────────────────────────────────────────────────────────────────────────
//  Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Deep-clone a value via JSON round-trip */
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Generate a random unique ID string */
const uid = () => 'id' + Math.random().toString(36).slice(2);

/**
 * Convert a name string to a slug safe for HA entity IDs.
 * e.g. "John Doe" → "john_doe"
 */
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Get initials from a name (up to 2 characters).
 * e.g. "John Doe" → "JD", "Alice" → "AL"
 */
const ini = (n) => n.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

/**
 * Format a point value, stripping trailing zeros after 3 decimal places.
 * e.g. 5.000 → "5", 3.333 → "3.333", 2.500 → "2.5"
 */
const formatPts = (val) => parseFloat(Number(val).toFixed(3)).toString();

/**
 * Produce a YYYY-M-D day key from a Date object.
 * Uses getMonth() (0-indexed) so keys are compact and unique per calendar day.
 */
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Return today's day-of-week index (0=Sun … 6=Sat) */
const todayIdx = () => new Date().getDay();

/**
 * Convert a <input type="date"> value (YYYY-MM-DD) to our internal dayKey format.
 * HA input dates use 1-indexed months; dayKey uses 0-indexed getMonth().
 */
const inputDateToKey = (val) => {
  if (!val) return dayKey(new Date());
  const [y, m, d] = val.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d));
};

/**
 * Convert an internal dayKey back to YYYY-MM-DD for <input type="date">.
 * dayKey stores month as 0-indexed, so we add 1 for the input value.
 */
const onceKeyToInputDate = (dk) => {
  if (!dk) return new Date().toISOString().slice(0, 10);
  const [y, m, d] = dk.split('-').map(Number);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Chore schedule helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a chore should appear on a given Date.
 * Handles all three schedule types: weekly, monthly, one-time.
 *
 * @param {Object} chore - Chore object from state
 * @param {Date}   d     - Date to check against
 * @returns {boolean}
 */
function choreVisibleOnDay(chore, d) {
  if (chore.oneTime)  return chore.oneTimeKey === dayKey(d);
  if (chore.monthly)  return d.getDate() === chore.monthDay;
  return Array.isArray(chore.days) && chore.days.includes(d.getDay());
}

/**
 * Return all chore/dayKey pairs that fall within the current week (Sun–Sat).
 * Used for the weekly summary bar and leaderboard points calculation.
 *
 * @param {Array} chores - All chores from state
 * @returns {Array<{chore, dayKey}>}
 */
function weekChores(chores) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - today.getDay() + i);
    const dk = dayKey(d);
    for (const c of chores) {
      if (choreVisibleOnDay(c, d)) out.push({ chore: c, dayKey: dk });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Completion helpers  (completions[dayKey] = [personId, ...])
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the array of person IDs who have claimed a chore on a given day.
 * Handles legacy format where completions[dk] was a single string.
 */
const claimers = (c, dk) => {
  const v = c.completions && c.completions[dk];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
};

/** Check whether a specific person has claimed a chore on a given day */
const hasClaimed = (c, dk, pid) => claimers(c, dk).includes(pid);

/** Check whether any person has claimed a chore on a given day */
const isClaimed = (c, dk) => claimers(c, dk).length > 0;

/**
 * Calculate points each claimer earns (exact division, 3 decimal places).
 * If unclaimed, returns the full chore point value.
 */
const splitPts = (c, dk) => {
  const n = claimers(c, dk).length;
  return n > 0 ? parseFloat((c.points / n).toFixed(3)) : c.points;
};

/**
 * Toggle a person's claim on a chore for a given day.
 * Mutates the chore object in place — caller must save state afterward.
 */
function toggleClaim(c, dk, pid) {
  if (!c.completions) c.completions = {};
  let arr = claimers(c, dk);
  arr = arr.includes(pid) ? arr.filter(x => x !== pid) : [...arr, pid];
  if (arr.length === 0) delete c.completions[dk];
  else c.completions[dk] = arr;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Points & leaderboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate each person's total points for the current week.
 * Points are split equally among all claimers of each chore.
 *
 * @param {Object} state - Full app state
 * @returns {Object} Map of personId → points (number, 3dp)
 */
function weeklyPts(state) {
  const pts = {};
  state.people.forEach(p => { pts[p.id] = 0; });
  for (const { chore, dayKey: dk } of weekChores(state.chores)) {
    const arr = claimers(chore, dk);
    if (!arr.length) continue;
    const each = chore.points / arr.length;
    for (const pid of arr) {
      if (pts[pid] !== undefined) pts[pid] = parseFloat((pts[pid] + each).toFixed(3));
    }
  }
  return pts;
}

/**
 * Find the current week's leader(s).
 * Returns null if nobody has earned any points yet.
 * Returns { people, pts, tied } where tied is true if multiple people share the top score.
 *
 * @param {Object} state - Full app state
 * @returns {Object|null}
 */
function leaders(state) {
  const pts = weeklyPts(state);
  if (!state.people.length) return null;
  const max = Math.max(...state.people.map(p => pts[p.id] || 0));
  if (max === 0) return null;
  const tied = state.people.filter(p => (pts[p.id] || 0) === max);
  return { people: tied, pts: max, tied: tied.length > 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSS styles (injected into shadow DOM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full CSS string for the card's shadow DOM.
 * Uses CSS custom properties so it adapts to HA's light/dark theme automatically.
 * Card-level overrides (dark mode, banner color) are applied via .dark class on :host.
 */
const getStyles = () => `
  /* ── Reset & base ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :host {
    /* Map HA's theme variables to our own for easy reference */
    --cc-bg:        var(--card-background-color, #fff);
    --cc-surface:   var(--secondary-background-color, #f0ede7);
    --cc-border:    var(--divider-color, #e0dbd2);
    --cc-text:      var(--primary-text-color, #18160f);
    --cc-text2:     var(--secondary-text-color, #6a6459);
    --cc-text3:     var(--disabled-text-color, #a49d94);
    --cc-accent:    var(--primary-color, #e05a10);
    --cc-accent-lt: rgba(224, 90, 16, 0.1);
    --cc-accent-dk: var(--dark-primary-color, #b84509);
    --cc-r:  12px;
    --cc-rs: 7px;

    /*
     * Critical sizing: the custom element host must fill its grid cell.
     * HA Sections dashboard places the card inside a grid cell — without
     * these rules the shadow DOM host collapses to its intrinsic size
     * regardless of how many columns/rows the grid allocates.
     */
    display: block;
    width: 100%;
    height: 100%;
    min-height: 300px; /* sensible floor so the card is usable when very small */

    font-family: var(--paper-font-body1_-_font-family, 'DM Sans', sans-serif);
    font-size: 14px;
    color: var(--cc-text);
  }

  /* ── Card wrapper — fills the host element ── */
  .card {
    background: var(--cc-bg);
    border-radius: var(--ha-card-border-radius, 12px);
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  /* ── Header — grid so nav is exactly centred regardless of logo/button widths ── */
  .hdr {
    background: var(--cc-bg);
    border-bottom: 1px solid var(--cc-border);
    padding: 0 1rem;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: 52px;
    flex-shrink: 0;
  }
  .hdr-right { display: flex; justify-content: flex-end; gap: 6px; }
  .logo {
    font-weight: 900;
    font-size: 17px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .logo-dot { color: var(--cc-accent); }
  .hdr-center { display: flex; align-items: center; gap: 8px; }
  .day-btn {
    width: 28px; height: 28px;
    border-radius: var(--cc-rs);
    border: 1px solid var(--cc-border);
    background: transparent;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; color: var(--cc-text2);
    transition: background .12s;
  }
  .day-btn:hover { background: var(--cc-surface); }
  .day-label {
    font-weight: 800; font-size: 14px;
    min-width: 90px; text-align: center;
  }
  .hdr-center { display: flex; align-items: center; gap: 8px; justify-content: center; }
  .icon-btn {
    width: 32px; height: 32px;
    border-radius: var(--cc-rs);
    border: 1px solid var(--cc-border);
    background: transparent;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; color: var(--cc-text2);
    transition: background .12s;
  }
  .icon-btn:hover { background: var(--cc-surface); }

  /* ── Main scrollable body — grows to fill card, chore list scrolls inside ── */
  .body {
    padding: .75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: .6rem;
    flex: 1;           /* fill remaining height after header */
    min-height: 0;     /* allow flex child to shrink below content size */
    overflow: hidden;  /* body itself doesn't scroll — only chore-list does */
  }

  /* ── Status pill ── */
  .status-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 10px; border-radius: 20px;
    font-size: 11.5px; border: 1px solid;
    flex-shrink: 0;
  }
  .status-pill.ok  { background: #edf7ed; border-color: #a5d6a7; color: #2e7d32; }
  .status-pill.err { background: #fdecea; border-color: #ef9a9a; color: #c62828; }
  .status-pill.cfg { background: #fffde7; border-color: #ffe082; color: #7b5b00; }
  .sdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }

  /* ── Dual summary banner row ── */
  .banner-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: .6rem;
    flex-shrink: 0;
  }

  /* ── Shared banner card base ── */
  .bcard {
    border-radius: var(--cc-r);
    padding: .7rem .9rem;
    display: flex; flex-direction: column;
    gap: .35rem; flex-shrink: 0;
    position: relative; overflow: hidden;
    cursor: pointer; transition: filter .15s;
    min-height: 80px;
  }
  .bcard:hover { filter: brightness(1.08); }
  .bcard.no-interact { cursor: default; }
  .bcard.no-interact:hover { filter: none; }
  .bglow {
    position: absolute; right: -20px; bottom: -20px;
    width: 100px; height: 100px;
    background: radial-gradient(circle, rgba(255,255,255,.06) 0%, transparent 70%);
    pointer-events: none;
  }
  .bcard-label {
    font-size: 9px; font-weight: 800; letter-spacing: .09em;
    text-transform: uppercase; opacity: .6; line-height: 1;
  }
  .bcard-main {
    font-weight: 900; font-size: 16px; color: #fff;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    line-height: 1.15;
  }
  .bcard-sub { font-size: 10px; opacity: .5; line-height: 1.3; }

  /* ── Champion card (dark themed) ── */
  .bcard-champion { background: #2c2a24; }
  .bcard-champion .bcard-label { color: rgba(255,200,50,.8); }
  .bcard-champion .bcard-main  { color: #fff; }
  .bcard-champion .bcard-sub   { color: rgba(255,255,255,.5); }
  /* champ-row sits below the label; extra top margin gives crown room */
  .champ-row { display: flex; align-items: center; gap: .55rem; margin-top: .6rem; }
  .champ-av-wrap { position: relative; flex-shrink: 0; }
  .champ-av {
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 900; font-size: 13px; color: #fff;
    border: 2px solid rgba(255,200,50,.4);
  }
  .champ-crown {
    position: absolute; top: -12px; left: 50%;
    transform: translateX(-50%); font-size: 11px; line-height: 1;
  }
  .champ-info { flex: 1; min-width: 0; }
  .champ-pts {
    font-size: 17px; font-weight: 900;
    color: rgba(255,200,50,.85); flex-shrink: 0;
    text-align: right; line-height: 1;
  }
  .champ-pts-lbl { font-size: 9px; opacity: .6; }

  /* ── This week card (configurable color, falls back to accent) ── */
  .bcard-week { background: var(--cc-accent); }
  .bcard-week .bcard-label { color: rgba(255,255,255,.7); }
  .bcard-week .bcard-main  { color: #fff; }
  .bcard-week .bcard-sub   { color: rgba(255,255,255,.6); }
  .week-progress { display: flex; flex-direction: column; gap: .3rem; flex: 1; }
  .wp-row { display: flex; align-items: center; gap: .4rem; }
  .wp-lbl { font-size: 9px; font-weight: 800; color: rgba(255,255,255,.65); width: 12px; text-align: center; flex-shrink: 0; }
  .wp-frac { font-size: 11px; font-weight: 900; color: #fff; min-width: 28px; flex-shrink: 0; }
  .wp-bar { flex: 1; height: 4px; background: rgba(255,255,255,.25); border-radius: 2px; overflow: hidden; }
  .wp-fill { height: 100%; background: rgba(255,255,255,.85); border-radius: 2px; transition: width .4s; }
  .week-lb { display: flex; gap: 4px; align-items: center; margin-top: .25rem; flex-wrap: wrap; }
  .week-lb-av {
    width: 20px; height: 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 8px; font-weight: 900; color: #fff;
    border: 1.5px solid rgba(255,255,255,.4); flex-shrink: 0;
    position: relative;
  }
  .week-lb-crown { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); font-size: 8px; pointer-events: none; }
  .week-lb-name { font-size: 9px; color: rgba(255,255,255,.75); font-weight: 600; }


  /* ── Chore header — two-row: [title + right] then [tabs] ── */
  .chore-hdr {
    display: flex; flex-direction: column;
    gap: .4rem; flex-shrink: 0;
  }
  /* Top bar: title on left, filters+add on right — never wraps */
  .chore-hdr-top {
    display: flex; align-items: center;
    justify-content: space-between; gap: .5rem;
  }
  .chore-hdr-title { font-weight: 900; font-size: 15px; white-space: nowrap; }
  .chore-hdr-right { display: flex; gap: 5px; align-items: center; flex-shrink: 0; }
  /* Tab row: centred, scrolls horizontally */
  .chore-hdr-tabs {
    display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
    justify-content: center;
  }
  .chore-hdr-tabs::-webkit-scrollbar { display: none; }

  .dtab {
    flex-shrink: 0; padding: 5px 11px; border-radius: 20px;
    border: 1px solid var(--cc-border); background: var(--cc-tab-bg, var(--cc-bg));
    font-size: 11.5px; font-weight: 500; cursor: pointer;
    transition: all .12s; color: var(--cc-text2); white-space: nowrap;
  }
  .dtab:hover { background: var(--cc-tab-bg, var(--cc-surface)); filter: brightness(.95); }
  .dtab.active { background: var(--cc-accent); border-color: var(--cc-accent); color: #fff; font-weight: 700; }
  .dtab.today { border-color: var(--cc-accent); color: var(--cc-accent); }
  .dtab.today.active { color: #fff; }

  /* ── Chore section — takes up all remaining vertical space ── */
  .chore-section { display: flex; flex-direction: column; gap: .5rem; flex: 1; min-height: 0; }
  .filters { display: flex; gap: 5px; }
  .fpill {
    padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 500;
    border: 1px solid var(--cc-border); background: var(--cc-bg);
    cursor: pointer; transition: all .12s; color: var(--cc-text2);
  }
  .fpill.active { background: var(--cc-accent); border-color: var(--cc-accent); color: #fff; }

  /* ── Chore list — only this section scrolls ── */
  .chore-list {
    display: flex; flex-direction: column; gap: 6px;
    flex: 1; min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--cc-border) transparent;
    padding-right: 2px; /* prevent scrollbar overlap */
  }
  .chore-item {
    background: var(--cc-chore-bg, var(--cc-bg)); border: 1px solid var(--cc-border);
    border-radius: var(--cc-r); padding: .6rem .75rem;
    display: flex; align-items: center; gap: .65rem;
    flex-shrink: 0; position: relative; overflow: hidden;
  }
  /* Colored left accent bar using person's color */
  .chore-item::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 4px; background: var(--item-color, var(--cc-border));
    border-radius: 4px 0 0 4px;
  }
  .chore-item.fully-done { background: var(--cc-surface); border-color: var(--cc-border); opacity: .85; }
  .ci-info { flex: 1; min-width: 0; }
  .ci-name { font-weight: 500; font-size: 14px; margin-bottom: 2px; }
  .ci-name.done-name { text-decoration: line-through; color: var(--cc-text3); }
  .ci-meta { font-size: 11px; color: var(--cc-text3); }
  .ci-pts {
    padding: 3px 9px; border-radius: 14px; font-size: 11px; font-weight: 700;
    background: var(--cc-accent-lt); color: var(--cc-accent-dk);
    flex-shrink: 0; white-space: nowrap;
  }
  .ci-pts.done-pts { background: #edf7ed; color: #2e7d32; }
  .one-time-badge {
    font-size: 10px; padding: 2px 6px; border-radius: 10px;
    background: var(--cc-surface); border: 1px solid var(--cc-border);
    color: var(--cc-text3); margin-left: 4px; vertical-align: middle;
  }

  /* ── Claim trigger — single ✓ button that opens the picker ── */
  .claim-trigger {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: 20px;
    border: 1.5px solid var(--cc-border);
    background: var(--cc-surface);
    cursor: pointer; font-size: 11.5px; font-weight: 600;
    color: var(--cc-text2); transition: all .15s;
    flex-shrink: 0; white-space: nowrap;
  }
  .claim-trigger:hover:not(:disabled) {
    border-color: var(--cc-accent); color: var(--cc-accent);
    background: var(--cc-accent-lt);
  }
  .claim-trigger.has-claims {
    border-color: var(--cc-accent); color: var(--cc-accent);
    background: var(--cc-accent-lt);
  }
  .claim-trigger:disabled { opacity: .35; cursor: not-allowed; }
  /* Small stacked avatar dots showing who has claimed */
  .claim-av-stack { display: flex; }
  .claim-av-stack .cav {
    width: 18px; height: 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 8px; font-weight: 900; color: #fff;
    margin-left: -5px; border: 1.5px solid var(--cc-bg);
    flex-shrink: 0;
  }
  .claim-av-stack .cav:first-child { margin-left: 0; }

  /* ── Claim picker — full-screen bottom sheet overlay ── */
  .claim-picker {
    position: fixed; inset: 0; z-index: 10001;
    display: flex; flex-direction: column; justify-content: flex-end;
    background: rgba(0,0,0,.45); backdrop-filter: blur(2px);
  }
  .claim-picker-sheet {
    background: var(--cc-bg); border-radius: 20px 20px 0 0;
    padding: 1rem 1rem 1.5rem; max-height: 70vh; overflow-y: auto;
    animation: slideUp .2s ease;
  }
  @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .claim-picker-handle {
    width: 36px; height: 4px; border-radius: 2px;
    background: var(--cc-border); margin: 0 auto .75rem;
  }
  .claim-picker-title {
    font-weight: 900; font-size: 15px; margin-bottom: .75rem; text-align: center;
  }
  .claim-picker-sub {
    font-size: 11px; color: var(--cc-text3); text-align: center; margin-bottom: 1rem;
  }
  .claim-picker-list {
    display: flex; flex-direction: column; gap: 8px;
  }
  .claim-picker-person {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; border-radius: var(--cc-r);
    border: 2px solid var(--cc-border); background: var(--cc-surface);
    cursor: pointer; transition: all .12s;
  }
  .claim-picker-person:hover { border-color: var(--cc-accent); background: var(--cc-accent-lt); }
  .claim-picker-person.claimed {
    border-color: var(--cc-accent); background: var(--cc-accent-lt);
  }
  .claim-picker-av {
    width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-weight: 900; font-size: 14px; color: #fff;
  }
  .claim-picker-name { flex: 1; font-weight: 700; font-size: 15px; }
  .claim-picker-check {
    font-size: 18px; color: var(--cc-accent); opacity: 0; transition: opacity .12s;
  }
  .claim-picker-person.claimed .claim-picker-check { opacity: 1; }
  .claim-picker-pts {
    font-size: 12px; color: var(--cc-text3); font-weight: 600;
  }
  .claim-picker-done {
    margin-top: 12px; width: 100%; padding: 12px;
    background: var(--cc-accent); color: #fff; border: none;
    border-radius: var(--cc-r); font-size: 15px; font-weight: 700;
    cursor: pointer;
  }




  /* ── Chore action buttons (edit/delete) ── */
  .ci-actions { display: flex; gap: 3px; flex-shrink: 0; }
  .ci-btn {
    width: 26px; height: 26px; border-radius: 6px;
    border: 1px solid var(--cc-border); background: transparent;
    cursor: pointer; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
    color: var(--cc-text3); transition: background .12s;
  }
  .ci-btn:hover { background: var(--cc-surface); }

  /* ── Empty & onboarding states ── */
  .empty { text-align: center; padding: 2rem 1rem; color: var(--cc-text3); }
  .empty h3 { font-weight: 800; font-size: 14px; margin-bottom: 5px; color: var(--cc-text2); }
  .onboard {
    background: var(--cc-bg); border: 2px dashed var(--cc-border);
    border-radius: var(--cc-r); padding: 2rem 1.5rem; text-align: center;
  }
  .onboard-icon { font-size: 36px; margin-bottom: .75rem; }
  .onboard h2 { font-weight: 900; font-size: 18px; margin-bottom: 6px; }
  .onboard p { color: var(--cc-text2); font-size: 13px; max-width: 300px; margin: 0 auto .75rem; line-height: 1.55; }
  .onboard-steps { display: flex; gap: .75rem; justify-content: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .ostep { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--cc-text2); }
  .onum {
    width: 20px; height: 20px; border-radius: 50%; background: var(--cc-accent);
    color: #fff; font-weight: 700; font-size: 11px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }

  /* ── Buttons ── */
  .btn {
    padding: 7px 14px; border-radius: var(--cc-rs);
    border: 1px solid var(--cc-border); background: var(--cc-bg);
    cursor: pointer; font-size: 13px; font-weight: 500;
    transition: all .12s; color: var(--cc-text);
    display: inline-flex; align-items: center; gap: 5px;
  }
  .btn:hover { background: var(--cc-surface); }
  .btn-primary { background: var(--cc-accent); border-color: var(--cc-accent); color: #fff; }
  .btn-primary:hover { background: var(--cc-accent-dk); }
  .btn-sm { padding: 5px 11px; font-size: 12px; }
  .btn-danger { color: #c62828; border-color: #ef9a9a; }

  /* ── Modals ── */
  .mbackdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.4);
    z-index: 9999; display: none; align-items: center; justify-content: center;
    padding: 1rem; backdrop-filter: blur(2px);
  }
  .mbackdrop.open { display: flex; }
  .modal {
    background: var(--cc-bg); border-radius: var(--cc-r);
    width: 100%; max-width: 440px; max-height: 90vh; overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,.18);
  }
  .mhdr {
    padding: 1rem 1.25rem .85rem; border-bottom: 1px solid var(--cc-border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .mtitle { font-weight: 900; font-size: 15px; }
  .mbody { padding: 1rem 1.25rem; }
  .mfooter {
    padding: .8rem 1.25rem; border-top: 1px solid var(--cc-border);
    display: flex; gap: 7px; justify-content: flex-end;
  }

  /* ── Form elements ── */
  .fg { margin-bottom: .85rem; }
  .flabel { display: block; font-size: 12px; font-weight: 500; margin-bottom: 5px; color: var(--cc-text2); }
  .finput {
    width: 100%; padding: 8px 11px;
    border: 1px solid var(--cc-border); border-radius: var(--cc-rs);
    font-size: 13px; background: var(--cc-bg); color: var(--cc-text);
    outline: none; transition: border-color .12s;
  }
  .finput:focus { border-color: var(--cc-accent); box-shadow: 0 0 0 3px rgba(224,90,16,.09); }
  .radio-opt { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--cc-text2); padding: 4px 0; }

  /* ── Day-of-week checkbox grid ── */
  .day-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
  .dchk { display: none; }
  .dchk-lbl {
    display: flex; align-items: center; justify-content: center;
    height: 32px; border-radius: var(--cc-rs);
    border: 1px solid var(--cc-border); font-size: 11px; font-weight: 600;
    cursor: pointer; transition: all .12s; color: var(--cc-text2); user-select: none;
  }
  .dchk:checked + .dchk-lbl { background: var(--cc-accent); border-color: var(--cc-accent); color: #fff; }

  /* ── Color swatches ── */
  .color-row { display: flex; gap: 7px; flex-wrap: wrap; }
  .cswatch {
    width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
    border: 3px solid transparent; transition: transform .12s, border-color .12s;
  }
  .cswatch:hover { transform: scale(1.15); }
  .cswatch.sel { border-color: var(--cc-text); }

  /* ── Settings sections ── */
  .ssect { margin-bottom: 1.25rem; }
  .ssect-title {
    font-weight: 800; font-size: 11px; text-transform: uppercase;
    letter-spacing: .07em; color: var(--cc-text3); margin-bottom: 8px;
  }
  .snote {
    font-size: 11.5px; color: var(--cc-text3); line-height: 1.55;
    margin-top: 8px; padding: 8px 10px;
    background: var(--cc-surface); border-radius: var(--cc-rs);
  }
  .snote code {
    font-family: monospace; font-size: 10.5px;
    background: var(--cc-border); padding: 1px 4px; border-radius: 3px;
  }
  .sdiv { height: 1px; background: var(--cc-border); margin: .9rem 0; }
  .plist { display: flex; flex-direction: column; gap: 6px; }
  .pitem {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border: 1px solid var(--cc-border); border-radius: var(--cc-rs);
  }
  .pav {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 12px; color: #fff; flex-shrink: 0;
  }
  .pname { flex: 1; font-weight: 500; font-size: 13px; }
  .ppts { font-size: 12px; color: var(--cc-text3); }

  /* ── Stats modal ── */
  .stats-ring-wrap {
    position: relative; width: 70px; height: 70px; margin: 0 auto 6px;
  }
  .stats-ring-label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-weight: 900; font-size: 15px;
  }

  /* ── Toast notification ── */
  .toast {
    position: fixed; bottom: 20px; left: 50%;
    transform: translateX(-50%) translateY(70px);
    background: #18160f; color: #fff;
    padding: 8px 18px; border-radius: 20px;
    font-size: 13px; z-index: 10000;
    transition: transform .25s; white-space: nowrap; pointer-events: none;
  }
  .toast.show { transform: translateX(-50%) translateY(0); }

  /* ── Sync indicator ── */
  .sync-indicator {
    position: absolute; top: 8px; right: 8px;
    width: 8px; height: 8px; border-radius: 50%;
    background: #a5d6a7; opacity: 0;
    transition: opacity .3s;
  }
  .sync-indicator.flash { opacity: 1; }

  /* ── Responsive — small screens (phone) ── */
  @media (max-width: 480px) {
    .banner-row { grid-template-columns: 1fr; }
    .body { padding: .5rem .75rem; gap: .45rem; }
    .hdr { padding: 0 .75rem; height: 48px; }
    .logo { font-size: 15px; }
    .day-label { min-width: 80px; font-size: 13px; }
    .bcard-main { font-size: 14px; }
  }

  /* ── Responsive — large / near-fullscreen ── */
  @media (min-width: 800px) {
    .body { padding: 1rem 1.25rem; gap: .75rem; }
    .hdr { height: 58px; padding: 0 1.25rem; }
    .logo { font-size: 19px; }
    .chore-item { padding: .75rem 1rem; }
    .ci-name { font-size: 15px; }
    .bcard-main { font-size: 18px; }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
//  ChoreChartCard — main custom element class
// ─────────────────────────────────────────────────────────────────────────────

class ChoreChartCard extends HTMLElement {
  constructor() {
    super();
    // Attach shadow DOM so our styles don't leak into or from HA's UI
    this.attachShadow({ mode: 'open' });

    // ── Internal state ──
    this._config     = {};           // YAML card config
    this._hass       = null;         // HA hass object (injected by Lovelace)
    this._state      = clone(EMPTY_STATE); // chore app state
    this._prefs      = this._loadPrefs(); // per-device preferences (theme, banner colors)
    this._dayOff     = 0;            // day offset from today (for browsing days)
    this._filter     = 'all';        // chore list filter: 'all' | 'open' | 'done'
    this._editChoreId  = null;       // ID of chore being edited (null = adding new)
    this._editPersonId = null;       // ID of person being edited (null = adding new)
    this._unsubscribe  = null;       // HA event subscription cleanup function
    this._deviceId     = uid();      // unique ID for this browser tab (echo prevention)
    this._saveTimer    = null;       // debounce timer for HA state pushes
    this._lastSeenTs   = null;       // timestamp of last remote state we applied

    // Build the initial DOM
    this._render();
    this._attachEventListeners();
  }

  // ── Lovelace lifecycle ────────────────────────────────────────────────────

  /**
   * Called by Lovelace when the card's YAML config is set.
   * Applies all visual config options to the rendered card immediately.
   */
  setConfig(config) {
    this._config = {
      title:         config.title         || 'Chore Chart',
      icon:          config.icon          !== undefined ? config.icon : 'mdi:broom',
      accent_color:  config.accent_color  || null,
      hide_header:   config.hide_header   || false,
      hide_settings: config.hide_settings || false,
      show_filters:  config.show_filters  !== false,
      tab_counts:    config.tab_counts    !== false,
      banner_color:  config.banner_color  || null,
      week_color:    config.week_color    || null,
      bg_color:      config.bg_color      || null,
      chore_color:   config.chore_color   || null,   // null = follows card background
      tab_color:     config.tab_color     || null,   // null = follows card background
      card_opacity:  config.card_opacity  !== undefined ? config.card_opacity : 1,
      ...config
    };
    this._applyVisualConfig();
  }

  /**
   * Apply visual config options to the rendered card DOM.
   * Called after setConfig and safe to call multiple times.
   */
  _applyVisualConfig() {
    const sr = this.shadowRoot;
    if (!sr) return;
    const card = sr.querySelector('.card');
    if (!card) return;

    // ── Icon + title in header ──
    const logo = sr.querySelector('.logo');
    if (logo) {
      const icon = this._config.icon; // empty string = no icon
      const iconHTML = icon
        ? `<ha-icon icon="${icon}" style="width:20px;height:20px;color:var(--cc-accent)"></ha-icon>`
        : ''; // no icon — title only
      logo.innerHTML = `${iconHTML}<span>${this._config.title || 'Chore Chart'}</span>`;
    }

    // ── Accent color override ──
    if (this._config.accent_color) {
      card.style.setProperty('--cc-accent', this._config.accent_color);
      card.style.setProperty('--cc-accent-lt', this._config.accent_color + '1a'); // 10% alpha
      card.style.setProperty('--cc-accent-dk', this._config.accent_color);
    } else {
      card.style.removeProperty('--cc-accent');
      card.style.removeProperty('--cc-accent-lt');
      card.style.removeProperty('--cc-accent-dk');
    }

    // ── Hide header ──
    const hdr = sr.querySelector('.hdr');
    if (hdr) hdr.style.display = this._config.hide_header ? 'none' : '';

    // ── Hide settings button (⚙) — lock down the card for kiosk/display use ──
    const btnSettings = sr.getElementById('btn-settings');
    if (btnSettings) btnSettings.style.display = this._config.hide_settings ? 'none' : '';

    // ── Hide chore edit/delete buttons when settings are locked ──
    // We inject a dynamic stylesheet into the shadow root to toggle .ci-actions
    // visibility — cleaner than re-rendering the entire chore list.
    let lockStyle = sr.getElementById('cc-lock-style');
    if (!lockStyle) {
      lockStyle = document.createElement('style');
      lockStyle.id = 'cc-lock-style';
      sr.appendChild(lockStyle);
    }
    lockStyle.textContent = this._config.hide_settings
      ? '.ci-actions { display: none !important; }'
      : '';

    // ── Show/hide filter pills (All / Open / Done) ──
    const filters = sr.getElementById('filters');
    if (filters) filters.style.display = this._config.show_filters ? '' : 'none';

    // ── Card background color + opacity ──
    // bg_color overrides the HA theme background. Opacity then applies alpha on top.
    // Both are set via --cc-bg so every surface (header, modals, chore items) inherits.
    const opacity  = parseFloat(this._config.card_opacity);
    const alpha    = (!isNaN(opacity) && opacity >= 0 && opacity <= 1) ? opacity : 1;
    const baseColor = this._config.bg_color
      ? this._config.bg_color           // user-chosen solid color
      : 'var(--card-background-color, #fff)'; // follow HA theme
    if (alpha < 1) {
      // Apply transparency via color-mix so only the background fades, not content
      card.style.setProperty('--cc-bg', `color-mix(in srgb, ${baseColor} ${Math.round(alpha * 100)}%, transparent)`);
    } else if (this._config.bg_color) {
      // Solid custom color, full opacity
      card.style.setProperty('--cc-bg', this._config.bg_color);
    } else {
      // Default — let HA theme handle it
      card.style.removeProperty('--cc-bg');
    }
    this.style.opacity = '';

    // ── Banner color from config (overrides in-card pref when set) ──
    if (this._config.banner_color) {
      this._prefs.bannerColor = this._config.banner_color;
    }
    // Apply to champion card (rendered via _renderWinner which reads _bannerBg)
    const champCard = sr.getElementById('banner-champion');
    if (champCard) champCard.style.background = this._bannerBg();

    // ── Chore item background color ──
    if (this._config.chore_color) {
      card.style.setProperty('--cc-chore-bg', this._config.chore_color);
    } else {
      card.style.removeProperty('--cc-chore-bg');
    }

    // ── Day tab background color ──
    if (this._config.tab_color) {
      card.style.setProperty('--cc-tab-bg', this._config.tab_color);
    } else {
      card.style.removeProperty('--cc-tab-bg');
    }

    // ── Week card color — overrides accent when set ──
    const weekCard = sr.getElementById('banner-week');
    if (weekCard) {
      weekCard.style.background = this._config.week_color || 'var(--cc-accent)';
    }
  }

  /**
   * Called by Lovelace every time HA state changes.
   * We use this to detect changes to our data entity and subscribe to events.
   */
  set hass(hass) {
    const firstSet = !this._hass;
    this._hass = hass;

    if (firstSet) {
      // First time hass is available — load state and subscribe to events
      this._initFromHA();
    }
  }

  /**
   * getCardSize — legacy Lovelace API.
   * Returns height in grid rows. Used by older dashboard layouts (Masonry).
   * For Sections dashboards, getLayoutOptions() below takes precedence.
   */
  getCardSize() {
    return this._config.grid_options?.rows || 8;
  }

  /**
   * getLayoutOptions — modern HA API (2023.9+).
   * Tells the visual editor the card's min/max/default grid dimensions,
   * which enables the drag-to-resize handles on Sections dashboards.
   */
  getLayoutOptions() {
    return {
      grid_columns:     this._config.grid_options?.columns     || 12,
      grid_rows:        this._config.grid_options?.rows        || 8,
      grid_min_columns: this._config.grid_options?.min_columns || 2,
      grid_min_rows:    this._config.grid_options?.min_rows    || 4,
      grid_max_columns: 12,
      grid_max_rows:    20,
    };
  }

  /**
   * getStubConfig — called by Lovelace when the card is first added from
   * the card picker. Returns the default configuration object.
   */
  static getStubConfig() {
    return {
      title: 'Chore Chart',
      grid_options: { columns: 12, rows: 8 }
    };
  }

  /**
   * getConfigElement — called by Lovelace to get the visual editor element.
   * Returning a custom element here enables the GUI editor tab in the
   * card editor panel instead of raw YAML only.
   * Wrapped defensively so a missing registration never breaks the card itself.
   */
  static getConfigElement() {
    try {
      return document.createElement('chore-chart-card-editor');
    } catch (e) {
      console.warn('[ChoreChart] Editor element not available:', e);
      return null;
    }
  }

  // ── Preferences (per-device, stored in localStorage) ─────────────────────

  /** Load per-device prefs from localStorage (banner colors) */
  _loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem('cc_prefs') || 'null') || {
        bannerColor: '#2c2a24'
      };
    } catch { return { bannerColor: '#2c2a24' }; }
  }

  /** Save per-device prefs to localStorage */
  _savePrefs() {
    try { localStorage.setItem('cc_prefs', JSON.stringify(this._prefs)); } catch {}
  }

  // ── HA integration ────────────────────────────────────────────────────────

  /**
   * Called once when hass first becomes available.
   * Loads state from HA and subscribes to live state change events.
   */
  async _initFromHA() {
    // Load saved state from our HA entity
    await this._loadStateFromHA();
    // Subscribe to state_changed events for real-time cross-device sync
    await this._subscribeToHA();
    this._refreshUI();
  }

  /**
   * Fetch chore state from HA entity `sensor.chore_chart_data`.
   * Falls back to empty state if the entity doesn't exist yet.
   */
  async _loadStateFromHA() {
    try {
      const entity = this._hass.states[STATE_ENTITY];
      if (entity && entity.attributes && entity.attributes.app_state) {
        const remote = entity.attributes.app_state;
        // Only use remote state if it looks valid
        if (remote && Array.isArray(remote.chores)) {
          this._state = remote;
          this._lastSeenTs = entity.last_changed;
        }
      }
    } catch (e) {
      console.warn('[ChoreChart] Failed to load state from HA:', e);
    }
  }

  /**
   * Subscribe to HA `state_changed` events via the hass WebSocket connection.
   * This is the native HA way — works in browser, mobile app, and all iframe contexts
   * because it piggybacks on the connection Lovelace already has open.
   */
  async _subscribeToHA() {
    if (!this._hass || !this._hass.connection) return;
    try {
      // Clean up any existing subscription first
      if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }

      this._unsubscribe = await this._hass.connection.subscribeEvents(
        (event) => this._handleHAEvent(event),
        'state_changed'
      );
    } catch (e) {
      console.warn('[ChoreChart] Failed to subscribe to HA events:', e);
    }
  }

  /**
   * Handle incoming HA state_changed events.
   * Applies remote state changes from other devices, ignoring our own echoes.
   *
   * @param {Object} event - HA state_changed event object
   */
  _handleHAEvent(event) {
    if (!event.data || event.data.entity_id !== STATE_ENTITY) return;

    const newState = event.data.new_state;
    if (!newState || !newState.attributes) return;

    const attrs = newState.attributes;
    const remoteState = attrs.app_state;
    const remoteDeviceId = attrs.device_id;

    // Skip if this is our own echo (we wrote this state)
    if (remoteDeviceId === this._deviceId) return;
    // Skip if we've already applied this exact update
    if (newState.last_changed === this._lastSeenTs) return;

    if (remoteState && Array.isArray(remoteState.chores)) {
      this._lastSeenTs = newState.last_changed;
      this._state = remoteState;
      this._refreshUI();
      this._flashSync();
    }
  }

  /**
   * Push the current state to HA as attributes on `sensor.chore_chart_data`.
   * Debounced to 600ms so rapid changes batch into a single write.
   * Uses hass.callApi which is fully authenticated — no token needed.
   */
  _saveState() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._pushStateToHA(), 600);
  }

  /** Actually push state to HA (called by debounced _saveState) */
  async _pushStateToHA() {
    if (!this._hass) return;
    try {
      // Push full app state — used for cross-device real-time sync
      await this._hass.callApi('POST', `states/${STATE_ENTITY}`, {
        state: new Date().toISOString(),
        attributes: {
          friendly_name: 'Chore Chart Data',
          icon:          'mdi:broom',
          device_id:     this._deviceId,
          app_state:     this._state
        }
      });
    } catch (e) {
      console.warn('[ChoreChart] Failed to push state to HA:', e);
    }

    // Always keep the four live entities up to date
    await this._syncLiveEntities();
  }

  /**
   * Write the four exposed HA sensor entities.
   * Called on every save so they always reflect current state in real time.
   *
   * Entities written:
   *   sensor.chore_chart_current_leader   — name(s) of the current week leader(s)
   *   sensor.chore_chart_last_winner      — name(s) of last week's champion(s)
   *   sensor.chore_chart_remaining_today  — unclaimed chores remaining today
   *   sensor.chore_chart_remaining_week   — unclaimed chores remaining this week
   */
  async _syncLiveEntities() {
    if (!this._hass) return;

    // ── Current leader ──
    // Show the week leader(s) by points. "None" if no points earned yet.
    const l         = leaders(this._state);
    const leaderStr = l
      ? (l.tied ? l.people.map(p => p.name).join(' & ') + ' (tied)' : l.people[0].name)
      : 'None';
    const leaderPts = l ? l.pts : 0;

    // ── Last winner ──
    const w         = this._state.lastWinner;
    const winnerStr = w
      ? ((w.names || [w.name]).join(' & ') + (w.tied ? ' (tied)' : ''))
      : 'None';

    // ── Remaining today ──
    // Count chores scheduled today that have not been claimed by anyone
    const today          = new Date();
    const todayKey       = dayKey(today);
    const todayChores    = this._state.chores.filter(c => choreVisibleOnDay(c, today));
    const remainingToday = todayChores.filter(c => !isClaimed(c, todayKey)).length;

    // ── Remaining this week ──
    // Count all chores scheduled this week (Sun–Sat) that are unclaimed
    const wk             = weekChores(this._state.chores);
    const remainingWeek  = wk.filter(({ chore, dayKey: dk }) => !isClaimed(chore, dk)).length;

    // Write all four in parallel — individual failures won't block the others
    await Promise.allSettled([
      this._hass.callApi('POST', 'states/sensor.chore_chart_current_leader', {
        state: leaderStr,
        attributes: {
          friendly_name: 'Chore Chart Current Leader',
          icon:          'mdi:crown',
          points:        leaderPts,
          tied:          l ? l.tied : false
        }
      }),
      this._hass.callApi('POST', 'states/sensor.chore_chart_last_winner', {
        state: winnerStr,
        attributes: {
          friendly_name: 'Chore Chart Last Winner',
          icon:          'mdi:trophy',
          week_of:       w ? w.weekOf : null,
          points:        w ? w.pts    : 0,
          tied:          w ? w.tied   : false
        }
      }),
      this._hass.callApi('POST', 'states/sensor.chore_chart_remaining_today', {
        state: String(remainingToday),
        attributes: {
          friendly_name:       'Chore Chart Remaining Today',
          icon:                'mdi:calendar-today',
          unit_of_measurement: 'chores'
        }
      }),
      this._hass.callApi('POST', 'states/sensor.chore_chart_remaining_week', {
        state: String(remainingWeek),
        attributes: {
          friendly_name:       'Chore Chart Remaining This Week',
          icon:                'mdi:calendar-week',
          unit_of_measurement: 'chores'
        }
      }),
    ]);
  }

  // ── End week ──────────────────────────────────────────────────────────────

  /**
   * Record this week's winner, save stats snapshot, clear all completions,
   * and push winner entities to HA for automations.
   */
  async _endWeek() {
    const l = leaders(this._state);
    if (!l) { this._toast('No points earned yet'); return; }

    const nameList = l.people.map(p => p.name).join(' & ');
    const msg = l.tied
      ? `Tie between ${nameList} (${l.pts} pts each). Record both as co-champions and reset?`
      : `Record "${l.people[0].name}" as champion (${l.pts} pts) and reset?`;
    if (!confirm(msg)) return;

    // ── Build per-person stats snapshot for the popup ──
    const wk          = weekChores(this._state.chores);
    const allPts       = weeklyPts(this._state);
    const winnerIds    = new Set(l.people.map(p => p.id));
    const totalAll     = wk.length;
    const doneAll      = wk.filter(({ chore, dayKey: dk }) => isClaimed(chore, dk)).length;
    const completionPct = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0;

    // Count chores each person personally claimed
    const choreCounts = {};
    this._state.people.forEach(p => { choreCounts[p.id] = 0; });
    for (const { chore, dayKey: dk } of wk) {
      for (const pid of claimers(chore, dk)) {
        if (choreCounts[pid] !== undefined) choreCounts[pid]++;
      }
    }

    // Determine winner chore count (average if tied)
    const winnerChores = l.tied
      ? Math.round(l.people.reduce((s, p) => s + choreCounts[p.id], 0) / l.people.length)
      : choreCounts[l.people[0].id];

    // Full per-person breakdown for the stats modal
    const personStats = this._state.people
      .map(p => ({ id: p.id, name: p.name, color: p.color, pts: allPts[p.id] || 0, chores: choreCounts[p.id] }))
      .sort((a, b) => b.pts - a.pts);

    // ── Store winner in state ──
    this._state.lastWinner = {
      names:          l.people.map(p => p.name),
      colors:         l.people.map(p => p.color),
      pts:            l.pts,
      tied:           l.tied,
      weekOf:         new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      totalChores:    winnerChores,
      personStats,
      totalChoresAll: totalAll,
      doneChoresAll:  doneAll,
      completionPct
    };

    // ── Reset all completions for a fresh week ──
    this._state.chores.forEach(c => { c.completions = {}; });

    this._saveState();
    this._closeModal('modal-settings');
    this._refreshUI();
    this._toast(l.tied ? `🤝 Tie! ${nameList} share the win!` : `🏆 ${l.people[0].name} wins the week!`);
  }

  // ── DOM rendering ─────────────────────────────────────────────────────────

  /**
   * Build the full card DOM into the shadow root.
   * Called once in the constructor.
   */
  _render() {
    const sr = this.shadowRoot;
    sr.innerHTML = `
      <style>${getStyles()}</style>

      <div class="card">
        <!-- ── Sync flash indicator (top-right dot) ── -->
        <div class="sync-indicator" id="sync-dot"></div>

        <!-- ── Header ── -->
        <div class="hdr">
          <div class="logo">
            ${this._config.icon ? `<ha-icon icon="${this._config.icon}" style="width:20px;height:20px;color:var(--cc-accent)"></ha-icon>` : ''}
            <span>${this._config.title || 'Chore Chart'}</span>
          </div>
          <div class="hdr-center">
            <button class="day-btn" id="btn-prev">‹</button>
            <span class="day-label" id="day-label">Today</span>
            <button class="day-btn" id="btn-next">›</button>
          </div>
          <div class="hdr-right">
            <button class="icon-btn" id="btn-settings" title="Settings">⚙</button>
          </div>
        </div>

        <!-- ── Scrollable body ── -->
        <div class="body">

          <!-- Dual banner row — champion card + this week card -->
          <div class="banner-row" id="banner-row" style="display:none">

            <!-- Last week champion card -->
            <div class="bcard bcard-champion" id="banner-champion">
              <div class="bglow"></div>
              <div class="bcard-label" id="bc-label">Last Week's Champion</div>
              <div class="champ-row">
                <div class="champ-av-wrap">
                  <div class="champ-crown" id="bc-crown">👑</div>
                  <div class="champ-av" id="bc-av"></div>
                </div>
                <div class="champ-info">
                  <div class="bcard-main" id="bc-name">No champion yet</div>
                  <div class="bcard-sub" id="bc-sub">End week to record a winner</div>
                </div>
                <div class="champ-pts" id="bc-pts" style="display:none">
                  <div id="bc-pts-val">0</div>
                  <div class="champ-pts-lbl">pts</div>
                </div>
              </div>
            </div>

            <!-- This week stats card -->
            <div class="bcard bcard-week" id="banner-week">
              <div class="bglow"></div>
              <div class="bcard-label">This Week</div>
              <div class="week-progress">
                <div class="wp-row">
                  <span class="wp-lbl">D</span>
                  <span class="wp-frac" id="bw-day-frac">0/0</span>
                  <div class="wp-bar"><div class="wp-fill" id="bw-day-bar" style="width:0%"></div></div>
                </div>
                <div class="wp-row">
                  <span class="wp-lbl">W</span>
                  <span class="wp-frac" id="bw-week-frac">0/0</span>
                  <div class="wp-bar"><div class="wp-fill" id="bw-week-bar" style="width:0%"></div></div>
                </div>
              </div>
              <div class="week-lb" id="bw-lb"></div>
            </div>

          </div>

          <!-- Onboarding (shown when no people have been added yet) -->
          <div class="onboard" id="onboard" style="display:none">
            <div class="onboard-icon">🏡</div>
            <h2>Welcome to Family Chores</h2>
            <p>Add your family, create chores, and tap names to claim points.</p>
            <div class="onboard-steps">
              <div class="ostep"><span class="onum">1</span>Add family in Settings</div>
              <div class="ostep"><span class="onum">2</span>Create chores</div>
              <div class="ostep"><span class="onum">3</span>Claim points!</div>
            </div>
            <button class="btn btn-primary" id="btn-onboard-settings">⚙ Open Settings</button>
          </div>

          <!-- Chore section: top row (title + filters + add), then tab row -->
          <div class="chore-section" id="chore-section" style="display:none">
            <div class="chore-hdr">
              <div class="chore-hdr-top">
                <span class="chore-hdr-title" id="chore-title">Today</span>
                <div class="chore-hdr-right">
                  <div class="filters" id="filters">
                    <span class="fpill active" data-f="all">All</span>
                    <span class="fpill" data-f="open">Open</span>
                    <span class="fpill" data-f="done">Done</span>
                  </div>
                  <button class="btn btn-primary btn-sm" id="btn-add-chore" title="Add chore">+</button>
                </div>
              </div>
              <div class="chore-hdr-tabs" id="day-tabs"></div>
            </div>
            <div class="chore-list" id="chore-list"></div>
          </div>
        </div><!-- /.body -->
      </div><!-- /.card -->

      <!-- ── Toast ── -->
      <div class="toast" id="toast"></div>

      <!-- ── Add/Edit Chore Modal ── -->
      <div class="mbackdrop" id="modal-chore">
        <div class="modal">
          <div class="mhdr">
            <span class="mtitle" id="mc-title">Add Chore</span>
            <button class="icon-btn" id="mc-close">✕</button>
          </div>
          <div class="mbody">
            <div class="fg"><label class="flabel">Chore name</label><input class="finput" id="c-name" type="text"></div>
            <div class="fg"><label class="flabel">Points</label><input class="finput" id="c-pts" type="number" min="0" max="100" value="5"></div>
            <div class="fg">
              <label class="flabel">Schedule</label>
              <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
                <label class="radio-opt"><input type="radio" name="cr" id="cr-weekly" value="weekly" checked style="accent-color:var(--cc-accent)"> Weekly</label>
                <label class="radio-opt"><input type="radio" name="cr" id="cr-monthly" value="monthly" style="accent-color:var(--cc-accent)"> Monthly</label>
                <label class="radio-opt"><input type="radio" name="cr" id="cr-once" value="once" style="accent-color:var(--cc-accent)"> One-time</label>
              </div>
              <div id="c-weekly-wrap"><div class="flabel" style="margin-bottom:5px">Days of week</div><div class="day-grid" id="c-days"></div></div>
              <div id="c-monthly-wrap" style="display:none"><label class="flabel" for="c-monthday">Day of month</label><input class="finput" id="c-monthday" type="number" min="1" max="31" value="1" style="width:100px"><div style="font-size:11px;color:var(--cc-text3);margin-top:5px">Skips months shorter than this day.</div></div>
              <div id="c-once-wrap" style="display:none"><label class="flabel" for="c-onedate">Date</label><input class="finput" id="c-onedate" type="date" style="width:180px"></div>
            </div>
            <div class="fg"><label class="flabel">Notes (optional)</label><input class="finput" id="c-notes" type="text"></div>
          </div>
          <div class="mfooter">
            <button class="btn" id="mc-cancel">Cancel</button>
            <button class="btn btn-primary" id="mc-save">Save Chore</button>
          </div>
        </div>
      </div>

      <!-- ── Settings Modal (data operations only — appearance is in the visual editor) ── -->
      <div class="mbackdrop" id="modal-settings">
        <div class="modal">
          <div class="mhdr"><span class="mtitle">Settings</span><button class="icon-btn" id="ms-close">✕</button></div>
          <div class="mbody">

            <div class="ssect">
              <div class="ssect-title">Family Members</div>
              <div class="plist" id="s-plist"></div>
              <button class="btn btn-sm" style="margin-top:8px" id="s-add-person">+ Add Person</button>
            </div>

            <div class="sdiv"></div>

            <div class="ssect">
              <div class="ssect-title">Week Management</div>
              <div style="display:flex;flex-direction:column;gap:6px">
                <button class="btn btn-primary btn-sm" id="s-end-week">🏆 End Week &amp; Record Winner</button>
                <button class="btn btn-sm" id="s-reset-week">↺ Reset Progress (no winner)</button>
                <button class="btn btn-sm btn-danger" id="s-clear">✕ Clear All Data</button>
              </div>
              <div class="snote" style="margin-top:8px">"End Week" records the champion, syncs HA entities, and clears completions for a fresh week.</div>
            </div>

          </div>
          <div class="mfooter">
            <button class="btn" id="ms-close2">Close</button>
          </div>
        </div>
      </div>

      <!-- ── Add/Edit Person Modal ── -->
      <div class="mbackdrop" id="modal-person">
        <div class="modal">
          <div class="mhdr">
            <span class="mtitle" id="mp-title">Add Family Member</span>
            <button class="icon-btn" id="mp-close">✕</button>
          </div>
          <div class="mbody">
            <div class="fg"><label class="flabel">Name</label><input class="finput" id="p-name" type="text"></div>
            <div class="fg"><label class="flabel">Color</label><div class="color-row" id="p-colors"></div></div>
          </div>
          <div class="mfooter">
            <button class="btn" id="mp-cancel">Cancel</button>
            <button class="btn btn-primary" id="mp-save">Save</button>
          </div>
        </div>
      </div>

      <!-- ── Last Week Stats Modal ── -->
      <div class="mbackdrop" id="modal-stats">
        <div class="modal">
          <div class="mhdr"><span class="mtitle">Last Week's Stats</span><button class="icon-btn" id="mst-close">✕</button></div>
          <div class="mbody" id="stats-body"></div>
          <div class="mfooter"><button class="btn btn-primary" id="mst-ok">Close</button></div>
        </div>
      </div>
    `;
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  /**
   * Attach all event listeners to the shadow DOM.
   * Called once after _render(). Uses event delegation on the shadow root
   * where possible to keep things tidy.
   */
  _attachEventListeners() {
    const $ = (id) => this.shadowRoot.getElementById(id);

    // ── Header navigation ──
    $('btn-prev').addEventListener('click', () => { this._dayOff--; this._refreshUI(); });
    $('btn-next').addEventListener('click', () => { this._dayOff++; this._refreshUI(); });
    $('btn-settings').addEventListener('click', () => this._openSettings());
    $('btn-onboard-settings').addEventListener('click', () => this._openSettings());

    // ── Single add chore button (inside chore section header) ──
    $('btn-add-chore').addEventListener('click', () => this._openChoreModal());

    // ── Champion banner click → last week stats popup ──
    $('banner-champion').addEventListener('click', () => {
      if (this._state.lastWinner) this._openStatsModal();
    });

    // ── Week banner click → week stats popup (uses same stats modal) ──
    $('banner-week').addEventListener('click', () => this._openWeekStatsModal());

    // ── Chore filters ──
    $('filters').querySelectorAll('.fpill').forEach(pill => {
      pill.addEventListener('click', () => {
        this._filter = pill.dataset.f;
        $('filters').querySelectorAll('.fpill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this._renderChores();
      });
    });

    // ── Chore modal ──
    $('mc-save').addEventListener('click', () => this._saveChore());
    $('mc-close').addEventListener('click', () => this._closeModal('modal-chore'));
    $('mc-cancel').addEventListener('click', () => this._closeModal('modal-chore'));

    // Schedule type radio buttons toggle visible section
    this.shadowRoot.querySelectorAll('input[name="cr"]').forEach(r => {
      r.addEventListener('change', () => this._applyScheduleUI(
        this.shadowRoot.querySelector('input[name="cr"]:checked').value
      ));
    });

    // ── Settings modal ──
    $('ms-close').addEventListener('click', () => this._closeModal('modal-settings'));
    $('ms-close2').addEventListener('click', () => this._closeModal('modal-settings'));
    $('s-add-person').addEventListener('click', () => this._openPersonModal());
    $('s-end-week').addEventListener('click', () => this._endWeek());
    $('s-reset-week').addEventListener('click', () => {
      if (!confirm('Reset all completions without recording a winner?')) return;
      this._state.chores.forEach(c => { c.completions = {}; });
      this._saveState(); this._refreshUI(); this._toast('Week reset');
    });
    $('s-clear').addEventListener('click', () => {
      if (!confirm('Clear ALL data? Cannot be undone.')) return;
      this._state = clone(EMPTY_STATE);
      this._saveState(); this._refreshUI();
      this._renderPersonList(); this._toast('Cleared');
    });

    // ── Person modal ──
    $('mp-save').addEventListener('click', () => this._savePerson());
    $('mp-close').addEventListener('click', () => { this._closeModal('modal-person'); this._openSettings(); });
    $('mp-cancel').addEventListener('click', () => { this._closeModal('modal-person'); this._openSettings(); });

    // ── Stats modal ──
    $('mst-close').addEventListener('click', () => this._closeModal('modal-stats'));
    $('mst-ok').addEventListener('click', () => this._closeModal('modal-stats'));

    // ── Close modals on backdrop click ──
    ['modal-chore', 'modal-settings', 'modal-person', 'modal-stats'].forEach(id => {
      $(id).addEventListener('click', e => { if (e.target.id === id) this._closeModal(id); });
    });
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────

  _openModal(id)  { this.shadowRoot.getElementById(id).classList.add('open'); }
  _closeModal(id) { this.shadowRoot.getElementById(id).classList.remove('open'); }

  // ── Theme ─────────────────────────────────────────────────────────────────

  /**
   * Return the banner background color from user preferences.
   * Theme (light/dark) is handled by HA itself — we just respect it via CSS vars.
   */
  _bannerBg() {
    return this._prefs.bannerColor || '#2c2a24';
  }

  // ── Full UI refresh ───────────────────────────────────────────────────────

  /** Refresh all UI sections. Called after state changes. */
  _refreshUI() {
    const hasPeople = this._state.people.length > 0;
    this._renderWinner();
    this._renderOnboard(hasPeople);
    if (hasPeople) {
      this._renderTopStrip();
      this._renderDayTabs();
      this._renderChores();
    }
    // Re-apply visual config after every render (icon, compact mode, etc.)
    this._applyVisualConfig();
  }

  // ── Top strip (week summary + leaderboard) ────────────────────────────────

  /** Show onboarding or main UI depending on whether people have been added */
  _renderOnboard(hasPeople) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('onboard').style.display       = hasPeople ? 'none'  : 'block';
    $('banner-row').style.display    = hasPeople ? 'grid'  : 'none';
    $('chore-section').style.display = hasPeople ? 'flex'  : 'none';
  }

  // ── Top strip (week summary + leaderboard) ────────────────────────────────

  _renderTopStrip() {
    this._renderWinner();
    this._renderWeekCard();
  }

  /** Render the champion card (left banner) */
  _renderWinner() {
    const $ = id => this.shadowRoot.getElementById(id);
    const w = this._state.lastWinner;
    const card = this.shadowRoot.getElementById('banner-champion');
    if (!card) return;

    // Apply banner background color from prefs/config
    card.style.background = this._bannerBg();

    if (!w) {
      // No winner yet — placeholder state, not clickable
      card.classList.add('no-interact');
      $('bc-label').textContent        = 'Last Week\'s Champion';
      $('bc-crown').style.display      = 'none';
      $('bc-av').textContent           = '?';
      $('bc-av').style.background      = 'rgba(255,255,255,0.15)';
      $('bc-av').style.border          = '2px dashed rgba(255,255,255,0.3)';
      $('bc-name').textContent         = 'No champion yet';
      $('bc-sub').textContent          = 'End the week to crown a winner';
      $('bc-pts').style.display        = 'none';
      return;
    }

    // Winner exists — make it interactive
    card.classList.remove('no-interact');
    const names  = w.names  || [w.name];
    const colors = w.colors || [w.color || '#888'];

    $('bc-label').textContent   = 'Last Week\'s Champion';
    $('bc-crown').style.display = '';
    $('bc-av').textContent      = w.tied && names.length > 1 ? '🤝' : ini(names[0]);
    $('bc-av').style.border     = '2px solid rgba(255,200,50,.45)';
    $('bc-av').style.background = w.tied && colors.length > 1
      ? `linear-gradient(135deg,${colors[0]} 50%,${colors[1]} 50%)`
      : colors[0];
    $('bc-name').textContent    = w.tied ? names.join(' & ') : names[0];
    $('bc-sub').textContent     = w.weekOf + (w.totalChores ? ` · ${w.totalChores} chores` : '');
    $('bc-pts').style.display   = '';
    $('bc-pts-val').textContent = w.pts;
  }

  /** Render the this-week card (right banner) with D/W progress + mini leaderboard */
  _renderWeekCard() {
    const $ = id => this.shadowRoot.getElementById(id);

    // ── Day progress ──
    const today      = new Date();
    const todayDk    = dayKey(today);
    const dayChores  = this._state.chores.filter(c => choreVisibleOnDay(c, today));
    const dayDone    = dayChores.filter(c => isClaimed(c, todayDk)).length;
    const dayTotal   = dayChores.length;
    const dayPct     = dayTotal > 0 ? Math.round((dayDone / dayTotal) * 100) : 0;

    // ── Week progress ──
    const wk         = weekChores(this._state.chores);
    const weekDone   = wk.filter(({ chore, dayKey: dk }) => isClaimed(chore, dk)).length;
    const weekTotal  = wk.length;
    const weekPct    = weekTotal > 0 ? Math.round((weekDone / weekTotal) * 100) : 0;

    if ($('bw-day-frac'))  $('bw-day-frac').textContent = `${dayDone}/${dayTotal}`;
    if ($('bw-day-bar'))   $('bw-day-bar').style.width  = dayPct + '%';
    if ($('bw-week-frac')) $('bw-week-frac').textContent = `${weekDone}/${weekTotal}`;
    if ($('bw-week-bar'))  $('bw-week-bar').style.width  = weekPct + '%';

    // ── Mini leaderboard avatars — detect ties ──
    const allPts  = weeklyPts(this._state);
    const sorted  = [...this._state.people].sort((a, b) => (allPts[b.id] || 0) - (allPts[a.id] || 0));
    const topPts  = allPts[sorted[0]?.id] || 0;
    const leaders = sorted.filter(p => topPts > 0 && (allPts[p.id] || 0) === topPts);
    const isTied  = leaders.length > 1;
    const lb = $('bw-lb');
    if (lb) {
      if (topPts === 0) {
        lb.innerHTML = `<span class="week-lb-name" style="opacity:.6">No points yet</span>`;
      } else {
        lb.innerHTML = sorted.map(p => {
          const myPts = allPts[p.id] || 0;
          const isTop = myPts > 0 && myPts === topPts;
          return `
            <div class="week-lb-av" style="background:${p.color}" title="${p.name}: ${myPts}pts">
              ${isTop ? '<span class="week-lb-crown">👑</span>' : ''}
              ${ini(p.name)}
            </div>`;
        }).join('') + (isTied
          ? `<span class="week-lb-name">Tied — ${leaders.map(p => p.name.split(' ')[0]).join(' & ')}</span>`
          : `<span class="week-lb-name">${leaders[0]?.name.split(' ')[0]} leads</span>`);
      }
    }
  }

  // ── Day tabs ──────────────────────────────────────────────────────────────

  /** Render day tabs inside the chore header row */
  _renderDayTabs() {
    const container = this.shadowRoot.getElementById('day-tabs');
    const today     = new Date();
    container.innerHTML = '';

    for (let i = -1; i <= 6; i++) {
      const d       = new Date(today);
      d.setDate(d.getDate() + i);
      const dk      = dayKey(d);
      const isToday = i === 0;
      const due     = this._state.chores.filter(c => choreVisibleOnDay(c, d));
      const done    = due.filter(c => isClaimed(c, dk)).length;

      const tab = document.createElement('span');
      tab.className = 'dtab' + (i === this._dayOff ? ' active' : '') + (isToday ? ' today' : '');
      const showCounts = this._config.tab_counts !== false;
      tab.textContent = (isToday ? 'Today' : DAYS[d.getDay()]) + (showCounts && due.length ? ` (${done}/${due.length})` : '');
      tab.addEventListener('click', () => { this._dayOff = i; this._refreshUI(); });
      container.appendChild(tab);
    }

    // Update chore section title and header day label
    const vd = this._viewDate();
    const dayStr = this._dayOff === 0
      ? 'Today'
      : DAYS[vd.getDay()] + ' ' + vd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const titleEl = this.shadowRoot.getElementById('chore-title');
    if (titleEl) titleEl.textContent = dayStr;
    const dayLabel = this.shadowRoot.getElementById('day-label');
    if (dayLabel) dayLabel.textContent = dayStr;
  }

  // ── Chore list ────────────────────────────────────────────────────────────

  /** Render the chore list for the currently viewed day */
  _renderChores() {
    const vd       = this._viewDate();
    const dk       = dayKey(vd);
    const isFuture = this._dayOff > 0;

    // Filter chores for this day, then apply active filter (all/open/done)
    let chores = this._state.chores.filter(c => choreVisibleOnDay(c, vd));
    const allDay  = [...chores];
    const doneDay = allDay.filter(c => isClaimed(c, dk));

    if (this._filter === 'open') chores = chores.filter(c => !isClaimed(c, dk));
    if (this._filter === 'done') chores = chores.filter(c =>  isClaimed(c, dk));

    // Update chore section title
    this.shadowRoot.getElementById('chore-title').textContent =
      this._dayOff === 0 ? 'Today' : DAYS[vd.getDay()];

    const list = this.shadowRoot.getElementById('chore-list');
    list.innerHTML = '';

    if (!chores.length) {
      list.innerHTML = `<div class="empty"><h3>${allDay.length === 0 ? 'Nothing scheduled' : 'Nothing to show'}</h3><p>${allDay.length === 0 ? 'No chores for this day.' : 'Try a different filter.'}</p></div>`;
      return;
    }

    for (const chore of chores) {
      const arr      = claimers(chore, dk);
      const claimed  = arr.length > 0;
      const split    = splitPts(chore, dk);

      // ── Claim trigger button — single ✓ button that opens picker for everyone ──
      const claimerList = arr.map(pid => {
        const p = this._state.people.find(x => x.id === pid);
        return p ? `<div class="cav" style="background:${p.color}" title="${p.name}">${ini(p.name)}</div>` : '';
      }).join('');
      const stackHTML = arr.length
        ? `<div class="claim-av-stack">${claimerList}</div>`
        : '';
      const triggerLabel = arr.length === 0 ? '✓ Claim' : arr.length === this._state.people.length ? '✓ All' : '✓ Edit';
      const claimTrigger = isFuture
        ? `<button class="claim-trigger" disabled title="Future day">🔒</button>`
        : `<button class="claim-trigger${arr.length ? ' has-claims' : ''}"
                   data-picker="${chore.id}" title="Claim this chore">
             ${stackHTML}${triggerLabel}
           </button>`;

      // ── Points badge — shows split when multiple claimers ──
      const ptsLabel = arr.length > 1
        ? `${formatPts(split)}pts ea`
        : claimed ? `✓ ${formatPts(split)}pts` : `${chore.points}pts`;

      // ── Schedule label ──
      let schedLabel;
      if      (chore.oneTime)  schedLabel = 'One-time';
      else if (chore.monthly)  schedLabel = `Monthly · day ${chore.monthDay}`;
      else                     schedLabel = '📅 ' + chore.days.map(d => DAYS[d]).join(', ');

      // ── Badge for non-weekly chores ──
      const badge = chore.oneTime
        ? '<span class="one-time-badge">once</span>'
        : chore.monthly ? '<span class="one-time-badge">monthly</span>' : '';

      // ── Determine left accent bar color (most recent claimer's color) ──
      const accentColor = arr.length > 0
        ? (this._state.people.find(p => p.id === arr[arr.length - 1])?.color || 'var(--cc-border)')
        : 'var(--cc-border)';

      const item = document.createElement('div');
      item.className = 'chore-item' + (claimed ? ' fully-done' : '');
      item.style.setProperty('--item-color', accentColor);
      item.innerHTML = `
        <div class="ci-info">
          <div class="ci-name${claimed ? ' done-name' : ''}">${chore.name}${badge}</div>
          <div class="ci-meta">${chore.notes ? '📝 ' + chore.notes + ' · ' : ''}${schedLabel}</div>
        </div>
        ${claimTrigger}
        ${isFuture
          ? ''
          : `<div class="ci-pts${claimed ? ' done-pts' : ''}">${ptsLabel}</div>`}
        <div class="ci-actions">
          <button class="ci-btn" data-edit="${chore.id}" title="Edit">✏</button>
          <button class="ci-btn" data-del="${chore.id}" title="Delete" style="color:#c62828">✕</button>
        </div>`;
      list.appendChild(item);
    }

    // ── Claim trigger → opens picker for all people ──
    list.querySelectorAll('[data-picker]').forEach(btn => {
      btn.addEventListener('click', () => this._openClaimPicker(btn.dataset.picker, dk));
    });
    list.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => this._openChoreModal(btn.dataset.edit));
    });
    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this chore?')) return;
        this._state.chores = this._state.chores.filter(c => c.id !== btn.dataset.del);
        this._saveState(); this._refreshUI(); this._toast('Deleted');
      });
    });
  }

  /** Open a popup showing this week's detailed stats */
  _openWeekStatsModal() {
    const wk        = weekChores(this._state.chores);
    const weekDone  = wk.filter(({ chore, dayKey: dk }) => isClaimed(chore, dk)).length;
    const weekTotal = wk.length;
    const allPts    = weeklyPts(this._state);
    const sorted    = [...this._state.people].sort((a, b) => (allPts[b.id] || 0) - (allPts[a.id] || 0));
    const pct       = weekTotal > 0 ? Math.round((weekDone / weekTotal) * 100) : 0;
    const circ      = 175.9;
    const dashArr   = Math.round((pct / 100) * circ);

    const personRows = sorted.map(p => {
      const myPts = allPts[p.id] || 0;
      const barW  = sorted[0] && allPts[sorted[0].id] > 0 ? Math.round((myPts / allPts[sorted[0].id]) * 100) : 0;
      return `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:28px;height:28px;border-radius:50%;background:${p.color};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;color:#fff;flex-shrink:0">${ini(p.name)}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px">
              <span style="font-size:13px;font-weight:500">${p.name}</span>
              <span style="font-size:12px;color:var(--cc-text3)"><b style="color:var(--cc-accent)">${formatPts(myPts)}pts</b></span>
            </div>
            <div style="height:4px;background:var(--cc-surface);border-radius:2px;overflow:hidden">
              <div style="width:${barW}%;height:100%;background:${p.color};border-radius:2px"></div>
            </div>
          </div>
        </div>`;
    }).join('');

    this.shadowRoot.getElementById('stats-body').innerHTML = `
      <div style="text-align:center;padding:.5rem 0 1rem">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cc-text3);margin-bottom:4px">This Week</div>
        <div style="font-weight:900;font-size:20px;margin-bottom:2px">${weekDone} of ${weekTotal} chores done</div>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:2rem;padding:.75rem 0;border-top:1px solid var(--cc-border);border-bottom:1px solid var(--cc-border);margin-bottom:1rem">
        <div style="text-align:center">
          <div class="stats-ring-wrap">
            <svg width="70" height="70" viewBox="0 0 70 70">
              <circle cx="35" cy="35" r="28" fill="none" stroke="var(--cc-border)" stroke-width="7"/>
              <circle cx="35" cy="35" r="28" fill="none" stroke="var(--cc-accent)" stroke-width="7"
                stroke-dasharray="${dashArr} ${circ}" stroke-linecap="round" transform="rotate(-90 35 35)"/>
            </svg>
            <div class="stats-ring-label">${pct}%</div>
          </div>
          <div style="font-size:11px;color:var(--cc-text3)">Completion</div>
        </div>
      </div>
      <div style="font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--cc-text3);margin-bottom:10px">Leaderboard</div>
      ${personRows || '<p style="color:var(--cc-text3);font-size:13px">No points earned yet this week.</p>'}`;

    this._openModal('modal-stats');
  }

  /**
   * Open the claim picker bottom sheet for a chore.
   * Consistent on desktop and mobile — shows all family members,
   * tap to toggle claim, Done to close.
   *
   * @param {string} choreId - ID of the chore to claim
   * @param {string} dk      - dayKey for the current viewed day
   */
  _openClaimPicker(choreId, dk) {
    const chore = this._state.chores.find(c => c.id === choreId);
    if (!chore) return;

    // Remove any existing picker
    const existing = this.shadowRoot.getElementById('claim-picker');
    if (existing) existing.remove();

    /** Build the person list HTML based on current claim state */
    const renderList = () => {
      const arr = claimers(chore, dk);
      const n   = arr.length;
      return this._state.people.map(p => {
        const mine   = arr.includes(p.id);
        // Show pts if claimed — recalculate split with current claimers
        const ptsStr = mine ? formatPts(chore.points / n) + ' pts' : '';
        return `
          <div class="claim-picker-person${mine ? ' claimed' : ''}" data-pid="${p.id}">
            <div class="claim-picker-av" style="background:${p.color}">${ini(p.name)}</div>
            <div class="claim-picker-name">${p.name}</div>
            <div class="claim-picker-pts">${ptsStr}</div>
            <div class="claim-picker-check">✓</div>
          </div>`;
      }).join('');
    };

    const picker = document.createElement('div');
    picker.id        = 'claim-picker';
    picker.className = 'claim-picker';
    picker.innerHTML = `
      <div class="claim-picker-sheet">
        <div class="claim-picker-handle"></div>
        <div class="claim-picker-title">${chore.name}</div>
        <div class="claim-picker-sub">${chore.points} pts · Tap a person to claim or unclaim</div>
        <div class="claim-picker-list" id="cp-list">${renderList()}</div>
        <button class="claim-picker-done" id="cp-done">Done</button>
      </div>`;

    this.shadowRoot.appendChild(picker);

    // Close on backdrop tap — refreshes the chore list to show updated state
    const closePicker = () => { picker.remove(); this._refreshUI(); };
    picker.addEventListener('click', e => { if (e.target === picker) closePicker(); });
    picker.querySelector('#cp-done').addEventListener('click', closePicker);

    /** Wire person row tap events — re-wires after each re-render */
    const wirePersons = () => {
      picker.querySelectorAll('.claim-picker-person').forEach(row => {
        row.addEventListener('click', () => {
          const pid        = row.dataset.pid;
          const wasClaimed = hasClaimed(chore, dk, pid);
          toggleClaim(chore, dk, pid);
          // Toast feedback
          const p2 = this._state.people.find(p => p.id === pid);
          if (!wasClaimed) {
            const n    = claimers(chore, dk).length;
            const each = formatPts(chore.points / n);
            this._toast(n > 1 ? `✓ ${each}pts each (split ${n} ways)!` : `✓ ${each}pts for ${p2?.name || '?'}!`);
          } else {
            this._toast('Unclaimed');
          }
          this._saveState();
          // Re-render just the picker list — full UI refresh happens on Done
          picker.querySelector('#cp-list').innerHTML = renderList();
          wirePersons();
        });
      });
    };
    wirePersons();
  }

  // ── Chore modal ───────────────────────────────────────────────────────────

  /**
   * Open the add/edit chore modal.
   * @param {string|null} choreId - If provided, pre-fills the form for editing.
   */
  _openChoreModal(choreId = null) {
    if (!this._state.people.length) { this._toast('Add a family member first!'); this._openSettings(); return; }
    this._editChoreId = choreId;
    const c    = choreId ? this._state.chores.find(x => x.id === choreId) : null;
    const type = c ? (c.oneTime ? 'once' : c.monthly ? 'monthly' : 'weekly') : 'weekly';
    const $    = (id) => this.shadowRoot.getElementById(id);

    $('mc-title').textContent = c ? 'Edit Chore' : 'Add Chore';
    $('c-name').value  = c ? c.name : '';
    $('c-pts').value   = c ? c.points : 5;
    $('c-notes').value = c ? (c.notes || '') : '';

    // Set active radio button
    $('cr-weekly').checked  = type === 'weekly';
    $('cr-monthly').checked = type === 'monthly';
    $('cr-once').checked    = type === 'once';
    this._applyScheduleUI(type);

    // Populate day checkboxes — when editing, restore saved days;
    // when adding new, leave all unchecked so the user picks intentionally.
    $('c-days').innerHTML = DAYS.map((d, i) => `
      <input type="checkbox" class="dchk" id="cd${i}" value="${i}"
             ${c && type === 'weekly' && c.days?.includes(i) ? 'checked' : ''}>
      <label class="dchk-lbl" for="cd${i}">${d}</label>`).join('');

    $('c-monthday').value = c && type === 'monthly' ? c.monthDay : new Date().getDate();

    const todayStr = new Date().toISOString().slice(0, 10);
    $('c-onedate').value = c && type === 'once' ? onceKeyToInputDate(c.oneTimeKey) : todayStr;
    $('c-onedate').min   = todayStr;

    this._openModal('modal-chore');
    $('c-name').focus();
  }

  /** Show/hide the correct schedule section based on radio selection */
  _applyScheduleUI(type) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('c-weekly-wrap').style.display  = type === 'weekly'  ? 'block' : 'none';
    $('c-monthly-wrap').style.display = type === 'monthly' ? 'block' : 'none';
    $('c-once-wrap').style.display    = type === 'once'    ? 'block' : 'none';
  }

  /** Validate and save the chore form */
  _saveChore() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const name = $('c-name').value.trim();
    if (!name) { this._toast('Enter a chore name'); return; }
    const raw    = $('c-pts').value;
    const points = raw === '' ? 5 : Math.max(0, parseFloat(raw) || 0);
    const notes  = $('c-notes').value.trim();
    const type   = this.shadowRoot.querySelector('input[name="cr"]:checked').value;

    let choreData;
    if (type === 'once') {
      const dateVal = $('c-onedate').value;
      if (!dateVal) { this._toast('Pick a date'); return; }
      choreData = { oneTime: true, monthly: false, oneTimeKey: inputDateToKey(dateVal), monthDay: null, days: [] };
    } else if (type === 'monthly') {
      const md = parseInt($('c-monthday').value) || 1;
      if (md < 1 || md > 31) { this._toast('Day must be 1–31'); return; }
      choreData = { oneTime: false, monthly: true, oneTimeKey: null, monthDay: md, days: [] };
    } else {
      const days = Array.from(this.shadowRoot.querySelectorAll('.dchk:checked')).map(cb => parseInt(cb.value));
      if (!days.length) { this._toast('Pick at least one day'); return; }
      choreData = { oneTime: false, monthly: false, oneTimeKey: null, monthDay: null, days };
    }

    if (this._editChoreId) {
      const idx = this._state.chores.findIndex(c => c.id === this._editChoreId);
      if (idx !== -1) this._state.chores[idx] = { ...this._state.chores[idx], name, points, notes, ...choreData };
      this._toast('Updated');
    } else {
      this._state.chores.push({ id: uid(), name, points, notes, ...choreData, completions: {} });
      this._toast('Chore added');
    }

    this._saveState();
    this._refreshUI();
    this._closeModal('modal-chore');
  }

  // ── Settings modal ────────────────────────────────────────────────────────

  /** Open the settings modal (data operations: people + week management) */
  _openSettings() {
    this._renderPersonList();
    this._openModal('modal-settings');
  }

  /** Render the person list inside settings */
  _renderPersonList() {
    const el  = this.shadowRoot.getElementById('s-plist');
    const pts = weeklyPts(this._state);

    if (!this._state.people.length) {
      el.innerHTML = '<div style="color:var(--cc-text3);font-size:12px;text-align:center;padding:.75rem 0">No members yet — add one below</div>';
      return;
    }

    el.innerHTML = this._state.people.map(p => `
      <div class="pitem">
        <div class="pav" style="background:${p.color}">${ini(p.name)}</div>
        <div class="pname">${p.name}</div>
        <div class="ppts">${formatPts(pts[p.id] || 0)}pts</div>
        <button class="ci-btn" data-ep="${p.id}" title="Edit">✏</button>
        <button class="ci-btn" data-dp="${p.id}" title="Remove" style="color:#c62828">✕</button>
      </div>`).join('');

    el.querySelectorAll('[data-ep]').forEach(b => b.addEventListener('click', () => this._openPersonModal(b.dataset.ep)));
    el.querySelectorAll('[data-dp]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Remove this person?')) return;
      this._state.people = this._state.people.filter(p => p.id !== b.dataset.dp);
      this._saveState(); this._renderPersonList(); this._refreshUI();
    }));
  }

  // ── Person modal ──────────────────────────────────────────────────────────

  /** Open the add/edit person modal */
  _openPersonModal(personId = null) {
    this._editPersonId = personId;
    const p = personId ? this._state.people.find(x => x.id === personId) : null;
    this.shadowRoot.getElementById('mp-title').textContent = p ? 'Edit Person' : 'Add Family Member';
    this.shadowRoot.getElementById('p-name').value = p ? p.name : '';

    const picker = this.shadowRoot.getElementById('p-colors');
    picker.innerHTML = COLORS.map(c => `
      <div class="cswatch${p && p.color === c ? ' sel' : ''}"
           style="background:${c}" data-c="${c}"></div>`).join('');
    picker.querySelectorAll('.cswatch').forEach(sw => {
      sw.addEventListener('click', () => {
        picker.querySelectorAll('.cswatch').forEach(s => s.classList.remove('sel'));
        sw.classList.add('sel');
      });
    });

    // Auto-select an unused color for new people
    if (!p) {
      const unused = COLORS.find(c => !this._state.people.find(x => x.color === c)) || COLORS[0];
      picker.querySelector(`[data-c="${unused}"]`)?.classList.add('sel');
    }

    this._closeModal('modal-settings');
    this._openModal('modal-person');
    this.shadowRoot.getElementById('p-name').focus();
  }

  /** Validate and save the person form */
  _savePerson() {
    const name = this.shadowRoot.getElementById('p-name').value.trim();
    if (!name) { this._toast('Enter a name'); return; }
    const color = this.shadowRoot.querySelector('#p-colors .cswatch.sel')?.dataset.c || COLORS[0];

    if (this._editPersonId) {
      const idx = this._state.people.findIndex(p => p.id === this._editPersonId);
      if (idx !== -1) this._state.people[idx] = { ...this._state.people[idx], name, color };
      this._toast('Updated');
    } else {
      this._state.people.push({ id: uid(), name, color });
      this._toast(`${name} added!`);
    }

    this._saveState();
    this._refreshUI();
    this._closeModal('modal-person');
    this._openSettings();
  }

  // ── Stats popup ───────────────────────────────────────────────────────────

  /** Open the last-week stats modal with completion ring and per-person breakdown */
  _openStatsModal() {
    const w = this._state.lastWinner;
    if (!w) return;

    const names       = w.names  || [w.name];
    const pct         = w.completionPct != null ? w.completionPct : 0;
    const total       = w.totalChoresAll || '—';
    const done        = w.doneChoresAll  || '—';
    const stats       = w.personStats   || [];
    // Circumference of r=28 circle
    const circ        = 175.9;
    const dashArr     = Math.round((pct / 100) * circ);

    // Per-person bar rows
    const personRows = stats.length
      ? stats.map(p => {
          const barW = stats[0].pts > 0 ? Math.round((p.pts / stats[0].pts) * 100) : 0;
          return `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <div style="width:28px;height:28px;border-radius:50%;background:${p.color};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;color:#fff;flex-shrink:0">${ini(p.name)}</div>
              <div style="flex:1;min-width:0">
                <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                  <span style="font-size:13px;font-weight:500">${p.name}</span>
                  <span style="font-size:12px;color:var(--cc-text3)">${p.chores} chore${p.chores !== 1 ? 's' : ''} · <b style="color:var(--cc-accent)">${formatPts(p.pts)}pts</b></span>
                </div>
                <div style="height:4px;background:var(--cc-surface);border-radius:2px;overflow:hidden">
                  <div style="width:${barW}%;height:100%;background:${p.color};border-radius:2px"></div>
                </div>
              </div>
            </div>`;
        }).join('')
      : '<p style="color:var(--cc-text3);font-size:13px">No per-person data recorded.</p>';

    this.shadowRoot.getElementById('stats-body').innerHTML = `
      <div style="text-align:center;padding:.5rem 0 1rem">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cc-text3);margin-bottom:4px">${w.tied ? 'Co-champions' : 'Champion'}</div>
        <div style="font-weight:900;font-size:22px;margin-bottom:2px">${names.join(' & ')}</div>
        <div style="font-size:12px;color:var(--cc-text3)">${w.weekOf}</div>
      </div>

      <div style="display:flex;align-items:center;justify-content:center;gap:2rem;padding:.75rem 0;border-top:1px solid var(--cc-border);border-bottom:1px solid var(--cc-border);margin-bottom:1rem">
        <div style="text-align:center">
          <div class="stats-ring-wrap">
            <svg width="70" height="70" viewBox="0 0 70 70">
              <circle cx="35" cy="35" r="28" fill="none" stroke="var(--cc-border)" stroke-width="7"/>
              <circle cx="35" cy="35" r="28" fill="none" stroke="var(--cc-accent)" stroke-width="7"
                stroke-dasharray="${dashArr} ${circ}"
                stroke-linecap="round" transform="rotate(-90 35 35)"/>
            </svg>
            <div class="stats-ring-label">${pct}%</div>
          </div>
          <div style="font-size:11px;color:var(--cc-text3)">Completion</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.75rem">
          <div><div style="font-weight:900;font-size:22px;color:var(--cc-accent);line-height:1">${done}</div><div style="font-size:11px;color:var(--cc-text3)">Chores done</div></div>
          <div><div style="font-weight:900;font-size:22px;color:var(--cc-accent);line-height:1">${total}</div><div style="font-size:11px;color:var(--cc-text3)">Total scheduled</div></div>
        </div>
      </div>

      <div style="font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--cc-text3);margin-bottom:10px">Breakdown</div>
      ${personRows}`;

    this._openModal('modal-stats');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Return the Date object for the currently viewed day */
  _viewDate() {
    const d = new Date();
    d.setDate(d.getDate() + this._dayOff);
    return d;
  }

  /** Flash the green sync dot briefly to indicate a remote state update arrived */
  _flashSync() {
    const dot = this.shadowRoot.getElementById('sync-dot');
    if (!dot) return;
    dot.classList.add('flash');
    setTimeout(() => dot.classList.remove('flash'), 1500);
  }

  /** Show a brief toast notification at the bottom of the card */
  _toast(msg) {
    const t = this.shadowRoot.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ChoreChartCardEditor — visual editor element
//
//  Handles ONLY card config options (appearance, layout, header).
//  Family members and week management live in the card's own ⚙ modal.
// ─────────────────────────────────────────────────────────────────────────────

class ChoreChartCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._built  = false;
  }

  setConfig(config) {
    this._config = { ...config };
    if (!this._built) { this._build(); this._built = true; }
    this._populate();
  }

  _build() {
    this.innerHTML = `
      <style>
        .cce {
          display: flex; flex-direction: column; gap: 20px;
          padding: 2px 0;
          font-family: var(--paper-font-body1_-_font-family, sans-serif);
          color: var(--primary-text-color);
        }
        .cce .stitle {
          font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .07em; color: var(--secondary-text-color);
          padding-bottom: 8px; border-bottom: 1px solid var(--divider-color);
        }
        .cce .row { display: flex; flex-direction: column; gap: 5px; }
        .cce .lbl { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); }
        .cce .inp {
          width: 100%; padding: 9px 11px;
          border: 1px solid var(--divider-color);
          border-radius: 8px; font-size: 13px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          outline: none; transition: border-color .15s; box-sizing: border-box;
        }
        .cce .inp:focus {
          border-color: var(--primary-color);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color) 15%, transparent);
        }
        .cce .icon-row { display: flex; gap: 8px; align-items: center; }
        .cce .icon-row .inp { flex: 1; }
        .cce .icon-preview {
          width: 36px; height: 36px; border-radius: 8px;
          border: 1px solid var(--divider-color);
          display: flex; align-items: center; justify-content: center;
          background: var(--secondary-background-color, #f0ede7);
          flex-shrink: 0; font-size: 18px;
        }
        .cce .clr-row { display: flex; align-items: center; gap: 10px; }
        .cce input[type="color"] {
          width: 36px; height: 36px; padding: 2px;
          border: 1px solid var(--divider-color); border-radius: 8px;
          cursor: pointer; background: none; flex-shrink: 0;
        }
        .cce .clr-reset {
          font-size: 12px; color: var(--secondary-text-color);
          cursor: pointer; text-decoration: underline;
        }
        .cce .clr-reset:hover { color: var(--primary-color); }
        .cce .tog-row {
          display: flex; align-items: flex-start;
          justify-content: space-between; gap: 12px; padding: 2px 0;
        }
        .cce .tog-text { flex: 1; }
        .cce .tog-lbl { font-size: 13px; }
        .cce .tog-sub { font-size: 11px; color: var(--secondary-text-color); margin-top: 2px; }
        .cce input[type="checkbox"].tog {
          width: 36px; height: 20px; flex-shrink: 0; margin-top: 2px;
          accent-color: var(--primary-color); cursor: pointer;
        }
        .cce .hint { font-size: 11px; color: var(--disabled-text-color, #a49d94); line-height: 1.4; }
        .cce .divider { height: 1px; background: var(--divider-color); }
        .cce .slider-row { display: flex; align-items: center; gap: 10px; }
        .cce input[type="range"] {
          flex: 1; accent-color: var(--primary-color); cursor: pointer; height: 4px;
        }
        .cce .slider-val {
          font-size: 13px; font-weight: 600; min-width: 36px;
          text-align: right; color: var(--primary-color);
        }
        .cce .info-box {
          font-size: 12px; color: var(--secondary-text-color); line-height: 1.6;
          padding: 10px 12px; background: var(--secondary-background-color, #f0ede7);
          border-radius: 8px;
        }
      </style>

      <div class="cce">

        <!-- ── Header ── -->
        <div class="stitle">Header</div>

        <div class="row">
          <label class="lbl" for="e-title">Card title</label>
          <input class="inp" type="text" id="e-title" placeholder="Chore Chart">
        </div>

        <div class="row">
          <label class="lbl">Icon <span style="font-weight:400;opacity:.7">(optional — any mdi: icon)</span></label>
          <div class="icon-row">
            <input class="inp" type="text" id="e-icon" placeholder="mdi:broom  or leave blank">
            <div class="icon-preview" id="e-icon-preview">—</div>
          </div>
          <div class="hint">e.g. <b>mdi:star</b>, <b>mdi:home</b>, <b>mdi:broom</b>. Leave blank for no icon.</div>
        </div>

        <div class="divider"></div>

        <!-- ── Appearance ── -->
        <div class="stitle">Appearance</div>

        <div class="row">
          <label class="lbl">Accent color</label>
          <div class="clr-row">
            <input type="color" id="e-accent" value="#e05a10">
            <span style="font-size:12px;color:var(--secondary-text-color)">Overrides HA theme color for this card</span>
            <span class="clr-reset" id="e-accent-reset">Reset</span>
          </div>
        </div>

        <div class="row">
          <label class="lbl">Champion banner color</label>
          <div class="clr-row">
            <input type="color" id="e-banner" value="#2c2a24">
            <span class="clr-reset" id="e-banner-reset">Reset</span>
          </div>
        </div>

        <div class="row">
          <label class="lbl">This Week card color</label>
          <div class="clr-row">
            <input type="color" id="e-week" value="#e05a10">
            <span style="font-size:12px;color:var(--secondary-text-color)">Defaults to accent color</span>
            <span class="clr-reset" id="e-week-reset">Reset</span>
          </div>
        </div>

        <div class="row">
          <label class="lbl">Card opacity</label>
          <div class="slider-row">
            <input type="range" id="e-opacity" min="0.1" max="1" step="0.05" value="1">
            <span class="slider-val" id="e-opacity-val">100%</span>
          </div>
          <div class="hint">Fades the card background only — text and content stay fully visible.</div>
        </div>

        <div class="row">
          <label class="lbl">Card background color</label>
          <div class="clr-row">
            <input type="color" id="e-bg" value="#ffffff">
            <span style="font-size:12px;color:var(--secondary-text-color)">Overrides HA theme background</span>
            <span class="clr-reset" id="e-bg-reset">Reset to theme</span>
          </div>
          <div class="hint">Works together with opacity — set a color then fade it for a tinted look.</div>
        </div>

        <div class="row">
          <label class="lbl">Chore box color</label>
          <div class="clr-row">
            <input type="color" id="e-chore" value="#ffffff">
            <span class="clr-reset" id="e-chore-reset">Reset</span>
          </div>
          <div class="hint">Background color for individual chore items.</div>
        </div>

        <div class="row">
          <label class="lbl">Day tab color</label>
          <div class="clr-row">
            <input type="color" id="e-tab" value="#ffffff">
            <span class="clr-reset" id="e-tab-reset">Reset</span>
          </div>
          <div class="hint">Background color for the day-of-week tab buttons.</div>
        </div>

        <div class="divider"></div>

        <!-- ── Layout ── -->
        <div class="stitle">Layout</div>

        <div class="tog-row">
          <div class="tog-text">
            <div class="tog-lbl">Hide header bar</div>
            <div class="tog-sub">Removes title, day navigation, and ⚙ button</div>
          </div>
          <input type="checkbox" class="tog" id="e-hide-hdr">
        </div>

        <div class="tog-row">
          <div class="tog-text">
            <div class="tog-lbl">Show counts on day tabs</div>
            <div class="tog-sub">e.g. "Mon (2/4)" — done vs scheduled</div>
          </div>
          <input type="checkbox" class="tog" id="e-tab-counts">
        </div>

        <div class="tog-row">
          <div class="tog-text">
            <div class="tog-lbl">Show filter buttons</div>
            <div class="tog-sub">Show/hide the All, Open, Done filter pills above the chore list</div>
          </div>
          <input type="checkbox" class="tog" id="e-show-filters">
        </div>

        <div class="tog-row">
          <div class="tog-text">
            <div class="tog-lbl">Hide settings button</div>
            <div class="tog-sub">Removes ⚙ and chore edit/delete — locks card for kiosk use</div>
          </div>
          <input type="checkbox" class="tog" id="e-hide-settings">
        </div>

        <div class="divider"></div>

        <!-- ── Info ── -->
        <div class="stitle">Setup</div>
        <div class="info-box">
          Use the <b>⚙ button inside the card</b> to add family members, manage chores, and end the week.<br><br>
          HA entities updated automatically on every change:<br>
          • <code style="font-family:monospace;font-size:10.5px;background:var(--divider-color);padding:1px 4px;border-radius:3px">sensor.chore_chart_current_leader</code><br>
          • <code style="font-family:monospace;font-size:10.5px;background:var(--divider-color);padding:1px 4px;border-radius:3px">sensor.chore_chart_last_winner</code><br>
          • <code style="font-family:monospace;font-size:10.5px;background:var(--divider-color);padding:1px 4px;border-radius:3px">sensor.chore_chart_remaining_today</code><br>
          • <code style="font-family:monospace;font-size:10.5px;background:var(--divider-color);padding:1px 4px;border-radius:3px">sensor.chore_chart_remaining_week</code>
        </div>

      </div>
    `;

    // Title
    this.querySelector('#e-title').addEventListener('input', e => {
      this._config = { ...this._config, title: e.target.value || 'Chore Chart' };
      this._fire();
    });

    // Icon — empty string = no icon
    this.querySelector('#e-icon').addEventListener('input', e => {
      const val = e.target.value.trim();
      this._previewIcon(val);
      this._config = { ...this._config, icon: val };
      this._fire();
    });

    // Accent color
    this.querySelector('#e-accent').addEventListener('input', e => {
      this._config = { ...this._config, accent_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-accent-reset').addEventListener('click', () => {
      this._config = { ...this._config, accent_color: null };
      this.querySelector('#e-accent').value = '#e05a10';
      this._fire();
    });

    // Banner color
    this.querySelector('#e-banner').addEventListener('input', e => {
      this._config = { ...this._config, banner_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-banner-reset').addEventListener('click', () => {
      this._config = { ...this._config, banner_color: null };
      this.querySelector('#e-banner').value = '#2c2a24';
      this._fire();
    });

    // Week card color
    this.querySelector('#e-week').addEventListener('input', e => {
      this._config = { ...this._config, week_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-week-reset').addEventListener('click', () => {
      this._config = { ...this._config, week_color: null };
      this.querySelector('#e-week').value = '#e05a10';
      this._fire();
    });

    // Layout toggles
    [
      ['e-hide-hdr',      'hide_header'],
      ['e-tab-counts',    'tab_counts'],
      ['e-show-filters',  'show_filters'],
      ['e-hide-settings', 'hide_settings'],
    ].forEach(([id, key]) => {
      this.querySelector('#' + id).addEventListener('change', e => {
        this._config = { ...this._config, [key]: e.target.checked };
        this._fire();
      });
    });

    // Opacity slider
    const opSlider = this.querySelector('#e-opacity');
    const opVal    = this.querySelector('#e-opacity-val');
    opSlider.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      opVal.textContent = Math.round(v * 100) + '%';
      this._config = { ...this._config, card_opacity: v };
      this._fire();
    });

    // Background color
    this.querySelector('#e-bg').addEventListener('input', e => {
      this._config = { ...this._config, bg_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-bg-reset').addEventListener('click', () => {
      this._config = { ...this._config, bg_color: null };
      this.querySelector('#e-bg').value = '#ffffff';
      this._fire();
    });

    // Chore box color
    this.querySelector('#e-chore').addEventListener('input', e => {
      this._config = { ...this._config, chore_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-chore-reset').addEventListener('click', () => {
      this._config = { ...this._config, chore_color: null };
      this.querySelector('#e-chore').value = '#ffffff';
      this._fire();
    });

    // Day tab color
    this.querySelector('#e-tab').addEventListener('input', e => {
      this._config = { ...this._config, tab_color: e.target.value };
      this._fire();
    });
    this.querySelector('#e-tab-reset').addEventListener('click', () => {
      this._config = { ...this._config, tab_color: null };
      this.querySelector('#e-tab').value = '#ffffff';
      this._fire();
    });
  }

  /** Update icon preview box */
  _previewIcon(iconName) {
    const box = this.querySelector('#e-icon-preview');
    if (!box) return;
    if (!iconName) {
      box.innerHTML = '—';
    } else {
      box.innerHTML = `<ha-icon icon="${iconName}" style="width:20px;height:20px"></ha-icon>`;
    }
  }

  _populate() {
    const c = this._config;
    const q = id => this.querySelector('#' + id);
    if (q('e-title'))         q('e-title').value          = c.title        || 'Chore Chart';
    if (q('e-icon'))          q('e-icon').value            = c.icon         || '';
    if (q('e-accent'))        q('e-accent').value          = c.accent_color || '#e05a10';
    if (q('e-banner'))        q('e-banner').value          = c.banner_color || '#2c2a24';
    if (q('e-week'))          q('e-week').value            = c.week_color   || '#e05a10';
    if (q('e-bg'))            q('e-bg').value              = c.bg_color     || '#ffffff';
    if (q('e-chore'))         q('e-chore').value           = c.chore_color  || '#ffffff';
    if (q('e-tab'))           q('e-tab').value             = c.tab_color    || '#ffffff';
    if (q('e-hide-hdr'))      q('e-hide-hdr').checked      = !!c.hide_header;
    if (q('e-tab-counts'))    q('e-tab-counts').checked    = c.tab_counts !== false;
    if (q('e-show-filters'))  q('e-show-filters').checked  = c.show_filters !== false;
    if (q('e-hide-settings')) q('e-hide-settings').checked = !!c.hide_settings;
    const op = c.card_opacity !== undefined ? parseFloat(c.card_opacity) : 1;
    if (q('e-opacity')) {
      q('e-opacity').value = op;
      q('e-opacity-val').textContent = Math.round(op * 100) + '%';
    }
    this._previewIcon(c.icon || '');
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config }, bubbles: true, composed: true
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//  Register the custom element with Lovelace
// ─────────────────────────────────────────────────────────────────────────────

// Register the editor first so it's available when getConfigElement() is called
customElements.define('chore-chart-card-editor', ChoreChartCardEditor);
customElements.define('chore-chart-card', ChoreChartCard);

/**
 * Tell Lovelace about this card so it appears in the card picker UI
 * with a proper name and description.
 */
window.customCards = window.customCards || [];
window.customCards.push({
  type:        'chore-chart-card',
  name:        'Chore Chart',
  description: 'Family chore tracking with points, leaderboard, and real-time sync across all devices.',
  preview:     true,
  documentationURL: 'https://github.com/YOUR_GITHUB_USERNAME/chore-chart-card'
});

console.info(
  '%c CHORE-CHART-CARD %c v1.0.0 ',
  'background:#e05a10;color:#fff;font-weight:700;padding:2px 6px;border-radius:3px 0 0 3px',
  'background:#1a1814;color:#fff;font-weight:400;padding:2px 6px;border-radius:0 3px 3px 0'
);
