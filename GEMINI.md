# 🧠 GEMINI.md - Agent Context & Technical Reference

This document serves as the developer and AI agent context file for the **Ultrabalaton Team Schedule Planner** codebase (`zsolooo/ultrun-planner`).

---

## 🎯 Project Overview & Purpose

The Ultrabalaton Team Schedule Planner is an offline-capable Progressive Web App (PWA) specifically built for ultra-running teams competing in the **NN Ultrabalaton** (~210 km loop around Lake Balaton, Hungary). 

The application solves the logistical challenge of:
1. Parsing official GPX race routes and auto-detecting team transition points (*váltópontok*).
2. Allowing custom filtering and selection of active transition points.
3. Managing runner rosters with distinct pacing, distance targets, and maximum run counts.
4. Assigning runners to route segments and computing real-time chained arrival/departure ETAs.
5. Exporting individual, multi-segment GPX files formatted for smartwatches (Garmin, Coros, Apple Watch, Suunto).
6. Operating completely offline around Lake Balaton with full data persistence.

---

## 🏗️ Architecture & Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                          index.html                         │
│   (App Shell, Header Actions, Stats Panel, Sidebar, Map)    │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
        ┌─────────────┐                ┌─────────────┐
        │  index.css  │                │   app.js    │
        │(Glass Theme,│                │(State Mgmt, │
        │ Responsive) │                │ Scheduling) │
        └─────────────┘                └──────┬──────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                               ▼                               ▼
       ┌──────────────┐                ┌──────────────┐                ┌──────────────┐
       │gpx-parser.js │                │  storage.js  │                │    sw.js     │
       │(XML Parsing, │                │ (IndexedDB,  │                │(PWA Caching, │
       │ Segmentation)│                │ JSON Backup) │                │   Offline)   │
       └──────────────┘                └──────────────┘                └──────────────┘
```

### File Breakdown

| File | Purpose |
| :--- | :--- |
| **`index.html`** | Application DOM structure, modal dialogs for runner management, mobile map toggle bars, and tab navigation. |
| **`index.css`** | Futuristic dark glassmorphic styling system. Contains desktop grid/flexbox layouts and mobile breakpoints (`<= 768px` and `<= 480px`) including the `.top-collapsed` mode. |
| **`app.js`** | Core application controller. Orchestrates UI event handlers, Leaflet map layers, runner modals, schedule recalculation loop, and state synchronization. |
| **`gpx-parser.js`** | Pure functional utility module. Handles XML parsing of `<trkpt>` and `<wpt>`, Haversine distance calculations, nearest trackpoint projection, Hungarian transition keyword detection (`csapat váltópont`), segment generation, and personalized GPX generation. |
| **`storage.js`** | Client-side database manager using IndexedDB (`UltrabalatonPlannerDB`). Manages stores for `route`, `runners`, `settings`, and `assignments`, and handles JSON backup import/export. |
| **`sw.js`** | Service Worker for offline asset pre-caching and network-fallback strategy. Cache versioning is managed via `CACHE_NAME = 'ub-planner-vX'`. |
| **`manifest.json`** | Web App Manifest defining standalone PWA behavior, theme colors (`#0a0f1d`), and icon assets. |
| **`NN_Ultrabalaton_2026.gpx`** | Default bundled 208.9 km GPX track containing trackpoints and Hungarian checkpoint waypoints. |

---

## 📊 Core Data Models & State Schema

The central application state is held in `app.js`:

```javascript
const state = {
  routeLoaded: false,
  trackPoints: [],       // Array of { index, lat, lon, ele, dist } (dist in km)
  waypoints: [],         // Array of { id, lat, lon, name, desc }
  activeTransitions: [], // Array of waypoints acting as segment boundaries (with trackIndex)
  segments: [],          // Generated segments between transitions: { id, fromWpt, toWpt, startIdx, endIdx, distance, elevationGain, elevationLoss, startTime, durationSeconds, runnerId }
  runners: [],           // Array of { id, name, paceSeconds, targetDistance, targetRuns, color, assignedDistance, assignedSegmentsCount, runs }
  assignments: {},       // Key-value mapping: segmentId -> runnerId
  startTime: Date,       // Race start timestamp (e.g. 2026-05-16T08:00:00)
  map: null,             // Leaflet map instance
  mapLayers: {
    routePolylines: [],  // Array of Leaflet Polyline objects per segment
    markers: []          // Array of Leaflet Marker objects
  },
  activeEditingRunnerId: null
};
```

---

## ⚙️ Key Algorithms & Logic

### 1. GPX Waypoint Classification & Filtering
Waypoints in `NN_Ultrabalaton_2026.gpx` include team exchange points, individual runner check-ins, water stations, and timing gates.
`detectTeamTransitions()` in `gpx-parser.js` filters waypoints based on keywords:
- Active keywords: `"csapat váltópont"`, `"csapat vf"`, `"váltópont"`.
- Each waypoint is projected onto the nearest track point using `haversineDistance()` to determine its exact track index and sequence distance.

### 2. Segment Generation & Elevation Metrics
- `generateSegments(trackPoints, activeTransitions)` slices the track into sequential segments.
- Elevation gain/loss is calculated on a 2-meter threshold to smooth out GPS noise.

### 3. Schedule & Pacing Engine (`recalculateSchedule` in `app.js`)
- Iterates sequentially through all segments starting from `state.startTime`.
- For each segment, retrieves the assigned runner's `paceSeconds` (or falls back to `330 sec/km` = 5:30 min/km).
- Calculates segment duration: `Math.round(segment.distance * paceSeconds)`.
- Updates segment start/finish ETAs and chains the clock to the next segment.
- Groups consecutive segments for the same runner into unified "Runs".
- Computes team aggregate stats: Total Distance, Planned Duration, Finish ETA, and **Team Average Pace** (formatted as rounded `M:SS min/km` without fractional seconds).

### 4. Smartwatch GPX Generation (`generateGPX` in `gpx-parser.js`)
- Synthesizes valid GPX 1.1 XML for an individual runner.
- Includes `<trkpt>` coordinates with computed `<time>` timestamps (ISO 8601) based on that runner's projected schedule.

### 5. Mobile Collapsible View (`.top-collapsed`)
- On screens `<= 768px`, user can toggle compact mode via `#btn-toggle-map` or `.btn-toggle-strip`.
- In `.top-collapsed` mode, `#map` is hidden (`display: none`), `.stats-panel` becomes a single-row flex strip (~34px), and the sidebar tab panel expands to 100% of remaining viewport height.
- Toggle state is persisted in `localStorage` under `ub_mobile_top_collapsed`.

---

## 🛠️ Development & Contribution Guidelines

### Local Testing
No build toolchain or npm dependencies required:
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080`.

### Syntax Validation
Before committing, validate all JS files with Node:
```bash
node -c app.js && node -c gpx-parser.js && node -c storage.js && node -c sw.js
```

### Service Worker Versioning
Whenever changing static assets (`index.html`, `index.css`, `app.js`, `storage.js`, `gpx-parser.js`), bump the `CACHE_NAME` constant in `sw.js` (e.g., `ub-planner-v3` -> `ub-planner-v4`) to ensure immediate cache invalidation for end-users.

### GitHub Actions CI/CD
Pushes to `main` or `master` automatically trigger `.github/workflows/deploy.yml`, deploying the application to GitHub Pages.
