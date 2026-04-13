# Chore Chart Card

A Home Assistant Lovelace custom card for tracking family chores. Built for real households — supports weekly, monthly, and one-time chores with a points-based leaderboard, claim picker, real-time sync across every device, and a full visual editor. No YAML required after installation.

![Chore Chart Card](https://raw.githubusercontent.com/Houndfeast5/chore-chart-card/main/screenshot.png)

---

## Features

- **Claim picker** — tap the ✓ button on any chore to open a full-screen picker. Multiple people can share a chore and split points equally.
- **Three schedule types** — weekly (pick specific days), monthly (pick a day of the month), or one-time (pick a date).
- **Live leaderboard** — week-to-date points for every family member with a crown on the leader. Handles ties.
- **Dual banner cards** — Last Week's Champion (clickable for detailed stats) + This Week (D/W progress bars + mini leaderboard, also clickable).
- **Real-time cross-device sync** — all state stored in `sensor.chore_chart_data`. Every device updates instantly via HA's native WebSocket. Works in the HA mobile app dashboard natively.
- **Full visual editor** — change colors, title, icon, layout, and display options without touching YAML.
- **Kiosk mode** — hide the settings button and chore edit controls to lock the card for wall displays.
- **Zero dependencies** — single JS file, no npm, no build step, no external libraries.

---

## Installation

### Via HACS (recommended)

1. Open HACS in your Home Assistant sidebar
2. Go to **Frontend**
3. Click **+ Explore & Download Repositories**
4. Search for **Chore Chart Card**
5. Click **Download**
6. Refresh your browser

### Manual

1. Download `chore-chart-card.js` from the [latest release](https://github.com/YOUR_GITHUB_USERNAME/chore-chart-card/releases/latest)
2. Copy it to `config/www/chore-chart-card.js`
3. Add it as a resource:
   - **Settings → Dashboards → Resources → Add Resource**
   - URL: `/local/chore-chart-card.js`
   - Type: **JavaScript module**
4. Refresh your browser (hard refresh: `Ctrl+Shift+R`)

---

## Usage

Add to any dashboard via the card picker UI, or in YAML:

```yaml
type: custom:chore-chart-card
title: Chore Chart
```

### First run

1. Open the card and tap **⚙**
2. Add family members under **Family Members**
3. Tap **+ Add Chore** to create your first chore
4. Tap the **✓ Claim** button on a chore to open the picker and assign points

---

## Visual Editor Options

All options are available in the visual editor (pencil icon in dashboard edit mode).

### Header
| Option | Description |
|--------|-------------|
| `title` | Card header title |
| `icon` | Any MDI icon (e.g. `mdi:broom`). Leave blank for none. |

### Appearance
| Option | Description |
|--------|-------------|
| `accent_color` | Override HA theme accent color for this card |
| `banner_color` | Champion banner background color |
| `week_color` | This Week card background color |
| `bg_color` | Card background color (overrides HA theme) |
| `chore_color` | Individual chore item background color |
| `tab_color` | Day tab button background color |
| `card_opacity` | Background opacity (0.1–1.0) |

### Layout
| Option | Description |
|--------|-------------|
| `hide_header` | Hide the title bar entirely |
| `hide_settings` | Hide ⚙ button and chore edit controls (kiosk mode) |
| `show_filters` | Show/hide the All/Open/Done filter pills |
| `tab_counts` | Show done/total counts on day tabs, e.g. `Mon (2/4)` |

---

## Home Assistant Entities

The card writes these entities automatically on every save. They are virtual state-machine entities — they do not persist through HA restarts and require no cleanup if you remove the card.

| Entity | State | Notes |
|--------|-------|-------|
| `sensor.chore_chart_data` | ISO timestamp | Full app state for cross-device sync |
| `sensor.chore_chart_current_leader` | Person name(s) | Current week leader, updates live |
| `sensor.chore_chart_last_winner` | Person name(s) | Last week's champion |
| `sensor.chore_chart_remaining_today` | Number | Unclaimed chores remaining today |
| `sensor.chore_chart_remaining_week` | Number | Unclaimed chores remaining this week |

### Example automation — announce when all today's chores are done

```yaml
alias: All chores done today
trigger:
  - platform: state
    entity_id: sensor.chore_chart_remaining_today
    to: "0"
action:
  - service: notify.mobile_app_your_phone
    data:
      title: "🏆 All done!"
      message: "All chores claimed for today."
```

### Example automation — TTS when week ends

```yaml
alias: Announce weekly winner
trigger:
  - platform: state
    entity_id: sensor.chore_chart_last_winner
action:
  - service: tts.speak
    data:
      message: "This week's chore champion is {{ states('sensor.chore_chart_last_winner') }}!"
```

---

## How sync works

State is stored in `sensor.chore_chart_data` as entity attributes. Every time any device saves (chore claimed, person added, week ended), it writes to this entity. All open instances subscribe to `state_changed` events via `hass.connection.subscribeEvents` — HA's own authenticated WebSocket — so every device receives updates instantly with no polling, no page refresh, and no extra configuration.

---

## Development

Single vanilla JS file, no build step.

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/chore-chart-card
cd chore-chart-card
cp chore-chart-card.js /path/to/ha/config/www/
```

Hard-refresh your browser after each change. Bump the `?v=` query string on the resource URL to force cache busting.

---

## Contributing

Pull requests welcome. Please keep it as a single JS file with no build step and add JSDoc comments to any new functions.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Changelog

### 1.0.0
- Initial release
- Weekly, monthly, and one-time chore scheduling
- Multi-person claim picker with split points
- Real-time HA sync via native WebSocket
- Dual banner cards (champion + this week stats)
- Full visual editor with color pickers for every surface
- Kiosk/display mode
- Four live HA sensor entities
