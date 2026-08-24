# 🏃 Ultrabalaton Team Schedule Planner

An offline-first Progressive Web App (PWA) for planning, pacing, assigning, and optimizing team relay schedules for the **NN Ultrabalaton** ultra-marathon (210 km around Lake Balaton, Hungary).

[![Deploy to GitHub Pages](https://github.com/zsolooo/ultrun-planner/actions/workflows/deploy.yml/badge.svg)](https://github.com/zsolooo/ultrun-planner/actions/workflows/deploy.yml)

---

## ✨ Features

- **🗺️ GPX Track Parsing & Auto-Segmentation**:
  - Automatically loads and parses the official 208.9 km Ultrabalaton GPX track.
  - Detects official team transition points (*csapat váltópontok*) and segments the route automatically.
  - Customizable transition point filtering to combine or split legs based on team strategy.
- **⏱️ Dynamic Schedule & Pacing Engine**:
  - Individual runner pace profiles (`min:sec / km`), target cumulative distances, and maximum run counts.
  - Automatic time calculation and arrival/departure ETA chaining for every segment and transition point.
  - Real-time team statistics: Total distance, planned team duration, estimated finish ETA, and rounded average pace.
- **🎨 Interactive Dark Theme Map**:
  - High-contrast glassmorphic dark theme powered by Leaflet.js.
  - Visual color-coded runner segments, waypoint markers, and interactive hover details.
- **⌚ Personalized Smartwatch GPX Export**:
  - Generate and download custom GPX track files for each individual runner with combined segments and projected timestamps for Garmin, Suunto, Coros, or Apple Watch.
- **📱 Mobile-First Responsive Design**:
  - Collapsible top statistics and map view to maximize screen space for planning, runners, and configuration on mobile devices.
  - Persistent user view preferences saved across reloads.
- **💾 Offline PWA & Data Persistence**:
  - Built with Service Worker caching for complete offline functionality during race weekend around Lake Balaton.
  - Full local storage via IndexedDB (`UltrabalatonPlannerDB`).
  - One-click JSON backup export and import for sharing schedules among team captains.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES Modules), HTML5, Modern CSS3 Glassmorphic Design System.
- **Mapping**: [Leaflet.js](https://leafletjs.com/) with inverted tile styling.
- **Storage**: IndexedDB for structured client-side persistence and `localStorage` for UI preferences.
- **PWA**: Service Worker with asset caching strategy (`sw.js`) and Web App Manifest (`manifest.json`).
- **CI/CD**: GitHub Actions deploying automatically to GitHub Pages on every push to `main`.

---

## 🚀 Getting Started

### Local Development

No build steps, compilers, or bundlers required. Run any static HTTP server in the repository root:

```bash
# Using Python 3
python3 -m http.server 8080

# Using Node.js (npx serve)
npx serve .
```

Open `http://localhost:8080` in your web browser.

---

## 📖 Usage Guide

1. **Load GPX Route**:
   - Click **"Load Route"** to load the bundled `NN_Ultrabalaton_2026.gpx` or upload a custom route GPX file.
2. **Configure Race Settings**:
   - In the **Settings** tab, set the team's official race start date and time (e.g. `16/05/2026 08:00`).
   - Filter active transition points if your team skips specific exchange stations.
3. **Manage Runners**:
   - In the **Runners** tab, click **"Add Runner"** to add teammates with their planned average pace (e.g., `5:30 min/km`), target distance, target number of runs, and assigned map color.
4. **Assign Segments**:
   - In the **Planning** tab, assign runners to each sequential stage. The schedule engine instantly recalculates segment start times, finish ETAs, and runner workloads.
5. **Overview & GPX Export**:
   - In the **Overview** tab, review summary statistics and download individual combined GPX files for each runner's smartwatch.
6. **Backup / Export**:
   - Click **"Export Data"** in the header to download a backup JSON file containing all runners, assignments, and settings.

---

## 📂 Project Structure

```
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages CI/CD workflow
├── NN_Ultrabalaton_2026.gpx# Default Ultrabalaton race track and waypoints
├── app.js                  # Main controller, UI event handling, pacing engine
├── gpx-parser.js           # GPX XML parsing, Haversine distance, GPX export
├── index.css               # Glassmorphism dark theme & responsive styles
├── index.html              # Main application shell and dialogs
├── manifest.json           # Web App Manifest for mobile installation
├── storage.js              # IndexedDB database management and backup import/export
├── sw.js                   # Service worker for offline PWA caching
└── icon-*.png              # App icons
```

---

## 📄 License

MIT License. Developed for Ultrabalaton runners and team captains.
