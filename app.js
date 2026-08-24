/**
 * app.js - Main Application Controller
 */

import { Storage } from './storage.js';
import {
  parseGPX,
  projectWaypointToTrack,
  detectTeamTransitions,
  generateSegments,
  generateGPX,
  haversineDistance
} from './gpx-parser.js';

// Predefined Runner Colors
const PREDEFINED_COLORS = [
  '#00f0ff', // Cyan
  '#39ff14', // Green
  '#ff00ff', // Magenta
  '#ffeb3b', // Yellow
  '#bd00ff', // Violet
  '#ff7300', // Orange
  '#ff2a85', // Pink
  '#0088ff'  // Azure
];

// App State
const state = {
  routeLoaded: false,
  trackPoints: [],      // Array of parsed { lat, lon, ele, dist }
  waypoints: [],        // Array of parsed { id, lat, lon, name, desc }
  activeTransitions: [], // Array of waypoints selected as transition points (with trackIndex added)
  segments: [],         // Calculated segments between active transitions
  runners: [],          // List of runners { id, name, paceSeconds, targetDistance, targetRuns, color }
  assignments: {},      // segmentId -> runnerId mapping
  startTime: new Date('2026-05-16T08:00:00'),
  map: null,
  mapLayers: {
    routePolylines: [], // Array of L.Polyline (one per segment)
    markers: []         // Array of L.Marker (one per active/inactive waypoint)
  },
  activeEditingRunnerId: null
};

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const btnLoadDefault = document.getElementById('btn-load-default');
const btnImportData = document.getElementById('btn-import-data');
const btnExportData = document.getElementById('btn-export-data');
const routeFileInput = document.getElementById('route-file-input');
const backupFileInput = document.getElementById('backup-file-input');

// Global Stats
const statDistance = document.getElementById('stat-distance');
const statDuration = document.getElementById('stat-duration');
const statFinishEta = document.getElementById('stat-finish-eta');
const statAvgPace = document.getElementById('stat-avg-pace');

// Tabs & Sidebar
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const runnersListContainer = document.getElementById('runners-list-container');
const segmentsListContainer = document.getElementById('segments-list-container');
const overviewContainer = document.getElementById('overview-runners-runs');
const waypointFiltersContainer = document.getElementById('waypoint-filters-container');
const inputStartTime = document.getElementById('input-start-time');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnClearDb = document.getElementById('btn-clear-db');
const btnInstallPwa = document.getElementById('btn-install-pwa');

// Map overlay details
const mapOverlay = document.getElementById('map-overlay');
const mapOverlaySegmentName = document.getElementById('map-overlay-segment-name');
const mapOverlaySegmentDetails = document.getElementById('map-overlay-segment-details');
const mapOverlayRunnerColor = document.getElementById('map-overlay-runner-color');
const mapOverlayRunnerName = document.getElementById('map-overlay-runner-name');
const mapOverlayEta = document.getElementById('map-overlay-eta');

// Modals
const dialogRunner = document.getElementById('dialog-runner');
const dialogRunnerTitle = document.getElementById('dialog-runner-title');
const formRunner = document.getElementById('form-runner');
const inputRunnerId = document.getElementById('input-runner-id');
const inputRunnerName = document.getElementById('input-runner-name');
const inputRunnerPaceMin = document.getElementById('input-runner-pace-min');
const inputRunnerPaceSec = document.getElementById('input-runner-pace-sec');
const inputRunnerDist = document.getElementById('input-runner-dist');
const inputRunnerRuns = document.getElementById('input-runner-runs');
const selectRunnerColor = document.getElementById('select-runner-color');
const btnAddRunner = document.getElementById('btn-add-runner');
const btnCancelDialog = document.getElementById('btn-cancel-dialog');
const btnCloseDialog = document.getElementById('btn-close-dialog');

// Initialize PWA Installation listener
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  btnInstallPwa.style.display = 'block';
});

btnInstallPwa.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log(`PWA install prompt outcome: ${outcome}`);
    deferredInstallPrompt = null;
    btnInstallPwa.style.display = 'none';
  }
});

// App Initialization
document.addEventListener('DOMContentLoaded', async () => {
  try {
    initMap();
    initTabEvents();
    initMobileCollapseEvents();
    initFormEvents();
    initDataEvents();
    
    // Register Service Worker for offline PWA support
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker registered:', reg.scope))
        .catch(err => console.warn('Service Worker registration failed:', err));
    }
    
    // Load state from DB
    await loadStateFromDB();
    
    // Recalculate schedule and draw
    if (state.trackPoints.length > 0) {
      state.routeLoaded = true;
      togglePlaceholders(false);
      recalculateSchedule();
      drawRouteOnMap();
    } else {
      // Prompt user to load route, or fetch the default GPX automatically
      console.log('No route stored, attempting to fetch default GPX...');
      await loadDefaultRoute();
    }
  } catch (err) {
    console.error('Initialization error:', err);
  } finally {
    // Hide loader
    loadingOverlay.style.opacity = '0';
    setTimeout(() => loadingOverlay.style.display = 'none', 500);
  }
});

// Map Initialization
function initMap() {
  // Lake Balaton coordinates
  state.map = L.map('map', {
    zoomControl: false
  }).setView([46.85, 17.75], 10);
  
  // Custom styled Zoom control
  L.control.zoom({
    position: 'topright'
  }).addTo(state.map);

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'Map data &copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
    maxZoom: 18
  }).addTo(state.map);
}

// Tab Switching Setup
function initTabEvents() {
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
      
      // Force map redraw on mobile layout changes
      if (state.map) {
        state.map.invalidateSize();
      }
    });
  });
}

// Mobile Top Area (Map & Stats) Collapse Toggle
function initMobileCollapseEvents() {
  const appContainer = document.querySelector('.app-container');
  const btnToggleMap = document.getElementById('btn-toggle-map');
  const btnToggleStrip = document.getElementById('btn-toggle-top-collapse');
  const stripText = document.querySelector('.toggle-strip-text');
  const headerMapText = document.querySelector('.btn-map-toggle-text');
  const iconCollapse = document.querySelector('.icon-collapse-strip');
  const iconExpand = document.querySelector('.icon-expand-strip');

  function updateCollapseUI(isCollapsed) {
    if (isCollapsed) {
      appContainer.classList.add('top-collapsed');
      if (stripText) stripText.textContent = 'Show Map & Full Stats';
      if (headerMapText) headerMapText.textContent = 'Show Map';
      if (iconCollapse) iconCollapse.style.display = 'none';
      if (iconExpand) iconExpand.style.display = 'inline-block';
      if (btnToggleMap) btnToggleMap.classList.add('active');
    } else {
      appContainer.classList.remove('top-collapsed');
      if (stripText) stripText.textContent = 'Hide Map & Compact Stats';
      if (headerMapText) headerMapText.textContent = 'Hide Map';
      if (iconCollapse) iconCollapse.style.display = 'inline-block';
      if (iconExpand) iconExpand.style.display = 'none';
      if (btnToggleMap) btnToggleMap.classList.remove('active');
      
      // Force leaflet map redraw after expand animation/display
      setTimeout(() => {
        if (state.map) {
          state.map.invalidateSize();
        }
      }, 200);
    }
  }

  function toggleCollapse() {
    const isCurrentlyCollapsed = appContainer.classList.contains('top-collapsed');
    const newState = !isCurrentlyCollapsed;
    updateCollapseUI(newState);
    try {
      localStorage.setItem('ub_mobile_top_collapsed', newState ? 'true' : 'false');
    } catch (e) {
      console.warn('Could not save collapsed state preference:', e);
    }
  }

  if (btnToggleMap) {
    btnToggleMap.addEventListener('click', toggleCollapse);
  }
  if (btnToggleStrip) {
    btnToggleStrip.addEventListener('click', toggleCollapse);
  }

  // Restore saved preference if on small screens
  try {
    const saved = localStorage.getItem('ub_mobile_top_collapsed');
    if (saved === 'true') {
      updateCollapseUI(true);
    }
  } catch (e) {
    // Ignore storage access errors
  }
}

// Add/Edit Runner Dialog Event Handlers
function initFormEvents() {
  btnAddRunner.addEventListener('click', () => {
    state.activeEditingRunnerId = null;
    dialogRunnerTitle.textContent = 'Add Runner';
    formRunner.reset();
    inputRunnerId.value = '';
    
    // Pick an unused color by default
    const usedColors = state.runners.map(r => r.color);
    const availableColor = PREDEFINED_COLORS.find(c => !usedColors.includes(c)) || PREDEFINED_COLORS[0];
    selectRunnerColor.value = availableColor;
    
    dialogRunner.showModal();
  });
  
  const closeDialog = () => dialogRunner.close();
  btnCancelDialog.addEventListener('click', closeDialog);
  btnCloseDialog.addEventListener('click', closeDialog);
  
  formRunner.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const runnerName = inputRunnerName.value.trim();
    const paceMin = parseInt(inputRunnerPaceMin.value, 10);
    const paceSec = parseInt(inputRunnerPaceSec.value, 10);
    const paceSeconds = (paceMin * 60) + paceSec;
    const targetDistance = parseFloat(inputRunnerDist.value);
    const targetRuns = parseInt(inputRunnerRuns.value, 10);
    const color = selectRunnerColor.value;
    
    if (!runnerName) return;
    
    if (state.activeEditingRunnerId) {
      // Edit mode
      const runner = state.runners.find(r => r.id === state.activeEditingRunnerId);
      if (runner) {
        runner.name = runnerName;
        runner.paceSeconds = paceSeconds;
        runner.targetDistance = targetDistance;
        runner.targetRuns = targetRuns;
        runner.color = color;
      }
    } else {
      // Add mode
      const newRunner = {
        id: `runner_${Date.now()}`,
        name: runnerName,
        paceSeconds,
        targetDistance,
        targetRuns,
        color
      };
      state.runners.push(newRunner);
    }
    
    await Storage.saveRunners(state.runners);
    recalculateSchedule();
    drawRouteOnMap();
    closeDialog();
  });
}

// Global actions, File loading and export handlers
function initDataEvents() {
  // Load Default GPX
  btnLoadDefault.addEventListener('click', async () => {
    // If double clicked, allow uploading custom GPX file instead
    routeFileInput.click();
  });
  
  routeFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const gpxXml = event.target.result;
      await processUploadedRoute(gpxXml);
    };
    reader.readAsText(file);
  });
  
  // Data Backup Export
  btnExportData.addEventListener('click', async () => {
    const backup = await Storage.exportBackup();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `Ultrabalaton_Planner_Backup_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });
  
  // Data Backup Import
  btnImportData.addEventListener('click', () => {
    backupFileInput.click();
  });
  
  backupFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        if (confirm('Importing this backup will overwrite your current settings, runners list and assignments. Continue?')) {
          loadingOverlay.style.display = 'flex';
          loadingOverlay.style.opacity = '1';
          
          await Storage.importBackup(backup);
          await loadStateFromDB();
          
          if (state.trackPoints.length > 0) {
            state.routeLoaded = true;
            togglePlaceholders(false);
            recalculateSchedule();
            drawRouteOnMap();
          }
          
          // Switch to overview tab
          document.querySelector('[data-tab="tab-map"]').click();
        }
      } catch (err) {
        alert('Failed to parse backup JSON file: ' + err.message);
      } finally {
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.style.display = 'none', 500);
      }
    };
    reader.readAsText(file);
  });

  // Settings Save
  btnSaveSettings.addEventListener('click', async () => {
    const newStartTimeStr = inputStartTime.value;
    if (newStartTimeStr) {
      state.startTime = new Date(newStartTimeStr);
      await Storage.saveSetting('startTime', newStartTimeStr);
      recalculateSchedule();
      drawRouteOnMap();
      alert('Start time updated and schedule recalculated successfully!');
    }
  });

  // Reset database
  btnClearDb.addEventListener('click', async () => {
    if (confirm('WARNING: This will permanently delete all route files, runners, and scheduling assignments. Are you absolutely sure?')) {
      await Storage.clearAll();
      window.location.reload();
    }
  });
}

// Fetch and load default route file (NN_Ultrabalaton_2026.gpx)
async function loadDefaultRoute() {
  try {
    const response = await fetch('NN_Ultrabalaton_2026.gpx');
    if (!response.ok) {
      throw new Error(`Server returned status: ${response.status}`);
    }
    const gpxText = await response.text();
    await processUploadedRoute(gpxText);
  } catch (err) {
    console.warn('Could not auto-load default route. Please use the "Load Route" button to upload a GPX.', err);
  }
}

// Parse and process a newly uploaded GPX XML text
async function processUploadedRoute(gpxXml) {
  try {
    loadingOverlay.style.display = 'flex';
    loadingOverlay.style.opacity = '1';
    
    // 1. Save GPX xml in DB
    await Storage.saveRouteGPX(gpxXml);
    
    // 2. Parse GPX content
    const parsed = parseGPX(gpxXml);
    state.trackPoints = parsed.trackPoints;
    state.waypoints = parsed.waypoints;
    
    if (state.trackPoints.length === 0) {
      throw new Error('No track points found in GPX track.');
    }
    
    // 3. Project waypoints onto track
    state.waypoints.forEach(wpt => {
      const projection = projectWaypointToTrack(wpt, state.trackPoints);
      wpt.trackIndex = projection.index;
      wpt.distanceToTrack = projection.distance; // error margin in km
    });

    // Sort waypoints chronologically along the track
    state.waypoints.sort((a, b) => a.trackIndex - b.trackIndex);
    
    // 4. Auto-detect active transition points
    // Let's filter waypoints by "csapat váltópont", "csapat váltó", "csapat vf", "váltópont"
    const detected = detectTeamTransitions(state.waypoints);
    
    // Ensure start of route (index 0) and end of route are included in active transitions
    const activeWpts = [];
    
    // Check if we have a waypoint extremely close to the start (within 300m)
    let startWpt = state.waypoints.find(w => w.trackIndex < 10 && w.distanceToTrack < 0.3);
    if (!startWpt) {
      startWpt = {
        id: 'start_wpt_virtual',
        lat: state.trackPoints[0].lat,
        lon: state.trackPoints[0].lon,
        name: 'Start Zone (Auto)',
        desc: 'Virtual Start Transition Point',
        trackIndex: 0,
        distanceToTrack: 0
      };
    }
    activeWpts.push(startWpt);

    // Add detected team transitions, excluding duplicates close to start/end
    detected.forEach(w => {
      if (w.trackIndex > 5 && w.trackIndex < (state.trackPoints.length - 10)) {
        // Ensure no duplicate index
        if (!activeWpts.some(added => added.trackIndex === w.trackIndex)) {
          activeWpts.push(w);
        }
      }
    });

    // Check if we have a waypoint close to the finish
    let endWpt = state.waypoints.find(w => w.trackIndex > (state.trackPoints.length - 10) && w.distanceToTrack < 0.3);
    if (!endWpt) {
      endWpt = {
        id: 'finish_wpt_virtual',
        lat: state.trackPoints[state.trackPoints.length - 1].lat,
        lon: state.trackPoints[state.trackPoints.length - 1].lon,
        name: 'Finish Zone (Auto)',
        desc: 'Virtual Finish Transition Point',
        trackIndex: state.trackPoints.length - 1,
        distanceToTrack: 0
      };
    }
    
    // Add end point if not already added
    if (!activeWpts.some(added => added.trackIndex === endWpt.trackIndex)) {
      activeWpts.push(endWpt);
    }
    
    // Re-sort
    activeWpts.sort((a, b) => a.trackIndex - b.trackIndex);
    state.activeTransitions = activeWpts;
    
    // Clear assignments since we have a new route
    state.assignments = {};
    
    // Save to settings
    const activeIds = state.activeTransitions.map(w => w.id);
    await Storage.saveSetting('activeTransitions', activeIds);
    await Storage.saveAssignments(state.assignments);
    
    state.routeLoaded = true;
    togglePlaceholders(false);
    
    // 5. Prepopulate default runners if empty
    const currentRunners = await Storage.getRunners();
    if (currentRunners.length === 0) {
      state.runners = [
        { id: 'runner_1', name: 'Alice (Cyan)', paceSeconds: 330, targetDistance: 35, targetRuns: 3, color: '#00f0ff' },
        { id: 'runner_2', name: 'Bob (Green)', paceSeconds: 360, targetDistance: 40, targetRuns: 3, color: '#39ff14' },
        { id: 'runner_3', name: 'Charlie (Magenta)', paceSeconds: 300, targetDistance: 30, targetRuns: 2, color: '#ff00ff' },
        { id: 'runner_4', name: 'Dave (Yellow)', paceSeconds: 390, targetDistance: 25, targetRuns: 2, color: '#ffeb3b' }
      ];
      await Storage.saveRunners(state.runners);
    }
    
    recalculateSchedule();
    drawRouteOnMap();
    
    // Zoom map to fit route
    if (state.map && state.trackPoints.length > 0) {
      const latlngs = state.trackPoints.map(p => [p.lat, p.lon]);
      state.map.fitBounds(L.polyline(latlngs).getBounds());
    }
  } catch (err) {
    alert('Error processing GPX file: ' + err.message);
  } finally {
    loadingOverlay.style.opacity = '0';
    setTimeout(() => loadingOverlay.style.display = 'none', 500);
  }
}

// Toggle "no route" HTML placeholders
function togglePlaceholders(hasRoute) {
  const sPlaceholder = document.getElementById('no-route-placeholder');
  if (sPlaceholder) {
    sPlaceholder.style.display = hasRoute ? 'none' : 'block';
  }
}

// Load state from IndexedDB
async function loadStateFromDB() {
  const gpxXml = await Storage.getRouteGPX();
  if (gpxXml) {
    const parsed = parseGPX(gpxXml);
    state.trackPoints = parsed.trackPoints;
    state.waypoints = parsed.waypoints;
    
    // Recalculate projections
    state.waypoints.forEach(wpt => {
      const projection = projectWaypointToTrack(wpt, state.trackPoints);
      wpt.trackIndex = projection.index;
      wpt.distanceToTrack = projection.distance;
    });
    state.waypoints.sort((a, b) => a.trackIndex - b.trackIndex);
    
    // Load active transition IDs
    const activeIds = await Storage.getSetting('activeTransitions', null);
    if (activeIds) {
      // Find matching waypoints
      state.activeTransitions = state.waypoints.filter(w => activeIds.includes(w.id));
      
      // Verify start and end points are always present
      if (!state.activeTransitions.some(w => w.trackIndex === 0)) {
        // Fallback: search or insert virtual start
        let startWpt = state.waypoints.find(w => w.trackIndex === 0) || {
          id: 'start_wpt_virtual',
          lat: state.trackPoints[0].lat,
          lon: state.trackPoints[0].lon,
          name: 'Start Zone (Auto)',
          desc: 'Virtual Start',
          trackIndex: 0,
          distanceToTrack: 0
        };
        state.activeTransitions.unshift(startWpt);
      }
      
      const lastIndex = state.trackPoints.length - 1;
      if (!state.activeTransitions.some(w => w.trackIndex === lastIndex)) {
        let endWpt = state.waypoints.find(w => w.trackIndex === lastIndex) || {
          id: 'finish_wpt_virtual',
          lat: state.trackPoints[lastIndex].lat,
          lon: state.trackPoints[lastIndex].lon,
          name: 'Finish Zone (Auto)',
          desc: 'Virtual Finish',
          trackIndex: lastIndex,
          distanceToTrack: 0
        };
        state.activeTransitions.push(endWpt);
      }
      
      state.activeTransitions.sort((a, b) => a.trackIndex - b.trackIndex);
    } else {
      // Run auto-detection
      const detected = detectTeamTransitions(state.waypoints);
      const activeWpts = [
        state.waypoints.find(w => w.trackIndex === 0) || { id: 'start_wpt_virtual', lat: state.trackPoints[0].lat, lon: state.trackPoints[0].lon, name: 'Start Zone (Auto)', trackIndex: 0, distanceToTrack: 0 }
      ];
      detected.forEach(w => {
        if (w.trackIndex > 0 && w.trackIndex < (state.trackPoints.length - 1)) {
          activeWpts.push(w);
        }
      });
      activeWpts.push(
        state.waypoints.find(w => w.trackIndex === state.trackPoints.length - 1) || { id: 'finish_wpt_virtual', lat: state.trackPoints[state.trackPoints.length - 1].lat, lon: state.trackPoints[state.trackPoints.length - 1].lon, name: 'Finish Zone (Auto)', trackIndex: state.trackPoints.length - 1, distanceToTrack: 0 }
      );
      activeWpts.sort((a, b) => a.trackIndex - b.trackIndex);
      state.activeTransitions = activeWpts;
    }
    
    // Load runners
    state.runners = await Storage.getRunners();
    
    // Load assignments
    state.assignments = await Storage.getAssignments();
    
    // Load Settings
    const startStr = await Storage.getSetting('startTime', '2026-05-16T08:00');
    state.startTime = new Date(startStr);
    inputStartTime.value = startStr;
  }
}

// Pacing & Time Formatting Helpers
function formatDuration(totalSeconds) {
  const totalSec = Math.round(totalSeconds || 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTime(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[date.getDay()];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${dayName} ${hours}:${minutes}`;
}

function formatPace(paceSeconds) {
  if (!paceSeconds || isNaN(paceSeconds) || paceSeconds <= 0) return '0:00';
  const totalSec = Math.round(paceSeconds);
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

// Core Recalculation Engine
function recalculateSchedule() {
  if (state.trackPoints.length === 0) return;
  
  // 1. Generate segments between active transition points
  state.segments = generateSegments(state.trackPoints, state.activeTransitions);
  
  // 2. Iterate segments and calculate ETA schedule
  let currentTime = new Date(state.startTime);
  let totalAssignedSeconds = 0;
  let totalAssignedDistance = 0;
  
  state.segments.forEach(segment => {
    segment.startTime = new Date(currentTime);
    
    const runnerId = state.assignments[segment.id];
    const runner = state.runners.find(r => r.id === runnerId);
    
    // Use runner pace or fallback pace (5:30 min/km = 330 sec/km)
    const pace = runner ? runner.paceSeconds : 330;
    const durationSeconds = Math.round(segment.distance * pace);
    
    segment.duration = durationSeconds;
    currentTime = new Date(currentTime.getTime() + durationSeconds * 1000);
    segment.endTime = new Date(currentTime);
    
    if (runner) {
      totalAssignedSeconds += durationSeconds;
      totalAssignedDistance += segment.distance;
    } else {
      // Even if unassigned, increment time so schedule estimated timeline is complete
      totalAssignedSeconds += durationSeconds;
      totalAssignedDistance += segment.distance;
    }
  });
  
  // 3. Compute runner load summaries
  // Clear runner distance totals
  state.runners.forEach(r => {
    r.assignedDistance = 0;
    r.assignedSegmentsCount = 0;
    r.runs = []; // grouped consecutive segments
  });
  
  // Group consecutive runner segments into "runs"
  let currentRun = null;
  state.segments.forEach((segment, idx) => {
    const runnerId = state.assignments[segment.id];
    if (runnerId) {
      const runner = state.runners.find(r => r.id === runnerId);
      if (runner) {
        runner.assignedDistance += segment.distance;
        runner.assignedSegmentsCount++;
        
        // Grouping consecutive runs
        if (currentRun && currentRun.runnerId === runnerId) {
          // Continue run
          currentRun.segments.push(segment);
          currentRun.distance += segment.distance;
          currentRun.eleGain += segment.eleGain;
          currentRun.eleLoss += segment.eleLoss;
          currentRun.endWpt = segment.endWpt;
          currentRun.endIndex = segment.endIndex;
          currentRun.endTime = segment.endTime;
        } else {
          // Save previous run
          if (currentRun) {
            const runRunner = state.runners.find(r => r.id === currentRun.runnerId);
            if (runRunner) runRunner.runs.push(currentRun);
          }
          // Start new run
          currentRun = {
            id: `run_${runnerId}_${idx}`,
            runnerId,
            segments: [segment],
            distance: segment.distance,
            eleGain: segment.eleGain,
            eleLoss: segment.eleLoss,
            startWpt: segment.startWpt,
            endWpt: segment.endWpt,
            startIndex: segment.startIndex,
            endIndex: segment.endIndex,
            startTime: segment.startTime,
            endTime: segment.endTime
          };
        }
      }
    } else {
      // Save current run if segment is unassigned
      if (currentRun) {
        const runRunner = state.runners.find(r => r.id === currentRun.runnerId);
        if (runRunner) runRunner.runs.push(currentRun);
        currentRun = null;
      }
    }
  });
  
  // Save final active run
  if (currentRun) {
    const runRunner = state.runners.find(r => r.id === currentRun.runnerId);
    if (runRunner) runRunner.runs.push(currentRun);
  }
  
  // 4. Update Header Stats
  const totalRouteDist = state.trackPoints[state.trackPoints.length - 1].dist;
  statDistance.textContent = `${totalRouteDist.toFixed(1)} km`;
  statDuration.textContent = formatDuration(totalAssignedSeconds);
  statFinishEta.textContent = formatTime(currentTime);
  const avgTeamPace = totalAssignedDistance > 0 ? (totalAssignedSeconds / totalAssignedDistance) : 0;
  statAvgPace.textContent = `${formatPace(avgTeamPace)} min/km`;
  
  // 5. Update Panels UI
  updateRunnersUI();
  updateSegmentsUI();
  updateOverviewUI();
  updateSettingsUI();
}

// Render Runners list
function updateRunnersUI() {
  runnersListContainer.innerHTML = '';
  
  if (state.runners.length === 0) {
    runnersListContainer.innerHTML = `
      <p style="color: var(--text-muted); font-size: 0.9rem; font-style: italic; text-align: center; padding: 20px;">
        No runners added. Click "Add Runner" to begin.
      </p>
    `;
    return;
  }
  
  state.runners.forEach(runner => {
    const distPct = Math.min((runner.assignedDistance / runner.targetDistance) * 100, 100);
    const distExceeded = runner.assignedDistance > runner.targetDistance;
    const runsExceeded = runner.runs.length > runner.targetRuns;
    
    const card = document.createElement('div');
    card.className = `runner-card ${runner.assignedSegmentsCount > 0 ? 'assigned' : 'unassigned'}`;
    card.style.setProperty('--runner-color', runner.color);
    
    card.innerHTML = `
      <div class="runner-header">
        <span class="runner-name">${runner.name}</span>
        <div class="runner-actions">
          <button class="btn btn-icon btn-small edit-runner-btn" data-id="${runner.id}" title="Edit Runner Parameters">
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
              <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5z"/>
            </svg>
          </button>
          <button class="btn btn-icon btn-small btn-danger delete-runner-btn" data-id="${runner.id}" title="Delete Runner">
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
              <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
              <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
            </svg>
          </button>
        </div>
      </div>
      
      <div class="runner-stats">
        <div class="runner-stat">
          <span class="runner-stat-label">Pace</span>
          <span class="runner-stat-val">${formatPace(runner.paceSeconds)}/km</span>
        </div>
        <div class="runner-stat">
          <span class="runner-stat-label">Target Dist</span>
          <span class="runner-stat-val">${runner.targetDistance} km</span>
        </div>
        <div class="runner-stat">
          <span class="runner-stat-label">Target Runs</span>
          <span class="runner-stat-val">${runner.targetRuns}</span>
        </div>
      </div>
      
      <div class="runner-progress">
        <div class="progress-text">
          <span>Distance: <strong>${runner.assignedDistance.toFixed(1)} km</strong></span>
          <span class="${distExceeded ? 'text-alert' : ''}">${distPct.toFixed(0)}%</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar ${distExceeded ? 'limit-exceeded' : ''}" style="width: ${distPct}%"></div>
        </div>
      </div>

      <div class="runner-progress" style="margin-top: 5px;">
        <div class="progress-text">
          <span>Number of Runs: <strong class="${runsExceeded ? 'text-alert' : ''}">${runner.runs.length} / ${runner.targetRuns}</strong></span>
        </div>
      </div>
    `;
    
    // Bind buttons
    card.querySelector('.edit-runner-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.currentTarget.getAttribute('data-id');
      editRunner(id);
    });
    
    card.querySelector('.delete-runner-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.currentTarget.getAttribute('data-id');
      deleteRunner(id);
    });
    
    runnersListContainer.appendChild(card);
  });
}

function editRunner(id) {
  const runner = state.runners.find(r => r.id === id);
  if (!runner) return;
  
  state.activeEditingRunnerId = id;
  dialogRunnerTitle.textContent = 'Edit Runner';
  
  inputRunnerName.value = runner.name;
  inputRunnerPaceMin.value = Math.floor(runner.paceSeconds / 60);
  inputRunnerPaceSec.value = runner.paceSeconds % 60;
  inputRunnerDist.value = runner.targetDistance;
  inputRunnerRuns.value = runner.targetRuns;
  selectRunnerColor.value = runner.color;
  
  dialogRunner.showModal();
}

async function deleteRunner(id) {
  const runner = state.runners.find(r => r.id === id);
  if (!runner) return;
  
  if (confirm(`Are you sure you want to remove runner ${runner.name}? Any assigned segments will become unassigned.`)) {
    state.runners = state.runners.filter(r => r.id !== id);
    
    // Remove segment assignments for this runner
    Object.keys(state.assignments).forEach(segId => {
      if (state.assignments[segId] === id) {
        delete state.assignments[segId];
      }
    });
    
    await Storage.saveRunners(state.runners);
    await Storage.saveAssignments(state.assignments);
    recalculateSchedule();
    drawRouteOnMap();
  }
}

// Render segments list in Planning tab
function updateSegmentsUI() {
  segmentsListContainer.innerHTML = '';
  
  if (state.segments.length === 0) {
    segmentsListContainer.innerHTML = `
      <p style="color: var(--text-muted); font-size: 0.9rem; font-style: italic; text-align: center; padding: 20px;">
        No segments found. Ensure GPX is loaded.
      </p>
    `;
    return;
  }
  
  state.segments.forEach((segment, idx) => {
    const runnerId = state.assignments[segment.id];
    const assignedRunner = state.runners.find(r => r.id === runnerId);
    
    const card = document.createElement('div');
    card.className = `segment-card ${assignedRunner ? 'assigned' : 'unassigned'}`;
    if (assignedRunner) {
      card.style.setProperty('--runner-color', assignedRunner.color);
    }
    
    card.innerHTML = `
      <div class="segment-header">
        <span class="segment-title">${segment.name}</span>
        <span class="segment-index">Seg ${idx + 1}</span>
      </div>
      
      <div class="segment-details">
        <div class="segment-detail-item">Dist: <strong>${segment.distance.toFixed(1)} km</strong></div>
        <div class="segment-detail-item">Gain: <strong>+${Math.round(segment.eleGain)}m</strong></div>
        <div class="segment-detail-item">Loss: <strong>-${Math.round(segment.eleLoss)}m</strong></div>
      </div>
      
      <div class="segment-assignment">
        <select class="runner-select" data-segment-id="${segment.id}">
          <option value="">-- Unassigned --</option>
          ${state.runners.map(r => `
            <option value="${r.id}" ${r.id === runnerId ? 'selected' : ''}>
              ${r.name} (${formatPace(r.paceSeconds)}/km)
            </option>
          `).join('')}
        </select>
        
        <div class="segment-time-calc">
          <div class="eta-label">Arrival ETA</div>
          <div class="eta-value">${formatTime(segment.endTime)}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted);">
            Time: ${formatDuration(segment.duration)}
          </div>
        </div>
      </div>
    `;
    
    // Bind select change
    card.querySelector('.runner-select').addEventListener('change', async (e) => {
      const segId = e.target.getAttribute('data-segment-id');
      const val = e.target.value;
      
      if (val) {
        state.assignments[segId] = val;
      } else {
        delete state.assignments[segId];
      }
      
      await Storage.saveAssignments(state.assignments);
      recalculateSchedule();
      drawRouteOnMap();
    });
    
    segmentsListContainer.appendChild(card);
  });
}

// Render Overview tab for GPX exports
function updateOverviewUI() {
  overviewContainer.innerHTML = '';
  
  // Find all runners who have runs
  const runnersWithRuns = state.runners.filter(r => r.runs && r.runs.length > 0);
  
  if (runnersWithRuns.length === 0) {
    overviewContainer.innerHTML = `
      <p id="no-runs-placeholder" style="color: var(--text-muted); font-size: 0.9rem; font-style: italic; text-align: center; padding: 20px;">
        No segments assigned yet. Go to the "Planning" tab to assign segments to runners.
      </p>
    `;
    return;
  }
  
  runnersWithRuns.forEach(runner => {
    const runnerBlock = document.createElement('div');
    runnerBlock.style.marginBottom = '20px';
    runnerBlock.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 1rem; color: #fff; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 5px;">
        <div style="width: 12px; height: 12px; border-radius: 50%; background-color: ${runner.color}; border: 1px solid #fff;"></div>
        <span>${runner.name}</span>
        <span style="font-weight: 400; font-size: 0.8rem; color: var(--text-muted); margin-left: auto;">
          ${runner.assignedDistance.toFixed(1)} km total
        </span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        ${runner.runs.map((run, rIdx) => `
          <div class="segment-card assigned" style="--runner-color: ${runner.color}; padding: 10px 12px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div>
                <div style="font-weight: 600; font-size: 0.9rem; color: #fff;">Run ${rIdx + 1}: ${run.startWpt.name.split(',')[0]} → ${run.endWpt.name.split(',')[0]}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">
                  Dist: <strong>${run.distance.toFixed(1)} km</strong> | Elev: <strong>+${Math.round(run.eleGain)}m / -${Math.round(run.eleLoss)}m</strong>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                  ETA: <span style="color: var(--color-primary); font-weight: 500;">${formatTime(run.startTime)} - ${formatTime(run.endTime)}</span>
                </div>
              </div>
              <button class="btn btn-primary btn-small export-gpx-btn" data-runner-id="${runner.id}" data-run-index="${rIdx}">
                <svg width="10" height="10" fill="currentColor" viewBox="0 0 16 16" style="margin-right: 2px;">
                  <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                  <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                </svg>
                GPX
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    // Bind GPX export button
    runnerBlock.querySelectorAll('.export-gpx-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const runIdx = parseInt(e.currentTarget.getAttribute('data-run-index'), 10);
        exportRunGPX(runner.id, runIdx);
      });
    });
    
    overviewContainer.appendChild(runnerBlock);
  });
}

// Generate and trigger GPX smartwatch download for a single runner run
function exportRunGPX(runnerId, runIdx) {
  const runner = state.runners.find(r => r.id === runnerId);
  if (!runner || !runner.runs || !runner.runs[runIdx]) return;
  
  const run = runner.runs[runIdx];
  const points = state.trackPoints.slice(run.startIndex, run.endIndex + 1);
  
  // Find waypoints that fall in this range
  const waypoints = state.waypoints.filter(w => w.trackIndex >= run.startIndex && w.trackIndex <= run.endIndex);
  
  const runName = `${runner.name}_Run_${runIdx + 1}_${run.startWpt.name.split(',')[0]}`;
  const gpxString = generateGPX(runName, points, waypoints);
  
  const dataStr = "data:text/xml;charset=utf-8," + encodeURIComponent(gpxString);
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `${runName.replace(/\s+/g, '_')}.gpx`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// Update waypoints list in Settings
function updateSettingsUI() {
  waypointFiltersContainer.innerHTML = '';
  
  if (state.waypoints.length === 0) {
    waypointFiltersContainer.innerHTML = `
      <p style="color: var(--text-muted); font-size: 0.8rem; font-style: italic; text-align: center; padding: 10px;">
        No GPX waypoints parsed yet.
      </p>
    `;
    return;
  }
  
  state.waypoints.forEach(wpt => {
    // Check if virtual
    if (wpt.id.includes('virtual')) return;
    
    const isActive = state.activeTransitions.some(w => w.id === wpt.id);
    const item = document.createElement('div');
    item.className = 'waypoint-toggle-item';
    
    item.innerHTML = `
      <div>
        <div class="waypoint-toggle-name" title="${wpt.name}">${wpt.name}</div>
        <div class="waypoint-toggle-desc">${(wpt.trackIndex / state.trackPoints.length * 211).toFixed(1)} km | ${(wpt.desc || 'Waypoint').substring(0, 30)}</div>
      </div>
      <label class="checkbox-container">
        <input type="checkbox" class="wpt-chk" data-id="${wpt.id}" ${isActive ? 'checked' : ''}>
        <span class="checkmark"></span>
      </label>
    `;
    
    item.querySelector('.wpt-chk').addEventListener('change', async (e) => {
      const id = e.target.getAttribute('data-id');
      const checked = e.target.checked;
      
      if (checked) {
        // Add to active transitions
        const matchingWpt = state.waypoints.find(w => w.id === id);
        if (matchingWpt && !state.activeTransitions.some(w => w.id === id)) {
          state.activeTransitions.push(matchingWpt);
        }
      } else {
        // Remove, but prevent removing start and end
        const matchingWpt = state.waypoints.find(w => w.id === id);
        if (matchingWpt) {
          // If it is mapped to trackIndex 0 or last index, we block removal or handle carefully
          if (matchingWpt.trackIndex === 0 || matchingWpt.trackIndex === state.trackPoints.length - 1) {
            alert('Cannot remove the starting or finishing transition points of the route.');
            e.target.checked = true;
            return;
          }
          state.activeTransitions = state.activeTransitions.filter(w => w.id !== id);
        }
      }
      
      // Sort transitions by trackIndex
      state.activeTransitions.sort((a, b) => a.trackIndex - b.trackIndex);
      
      // Save
      const activeIds = state.activeTransitions.map(w => w.id);
      await Storage.saveSetting('activeTransitions', activeIds);
      
      recalculateSchedule();
      drawRouteOnMap();
    });
    
    waypointFiltersContainer.appendChild(item);
  });
}

// Draw Route and Transition Point Markers on Map
function drawRouteOnMap() {
  if (!state.map || state.trackPoints.length === 0) return;
  
  // 1. Clear existing polylines
  state.mapLayers.routePolylines.forEach(l => state.map.removeLayer(l));
  state.mapLayers.routePolylines = [];
  
  // 2. Clear existing markers
  state.mapLayers.markers.forEach(m => state.map.removeLayer(m));
  state.mapLayers.markers = [];
  
  // 3. Draw each segment as a separate color-coded polyline
  state.segments.forEach((segment) => {
    const runnerId = state.assignments[segment.id];
    const runner = state.runners.find(r => r.id === runnerId);
    
    const segmentPts = state.trackPoints.slice(segment.startIndex, segment.endIndex + 1);
    const latlngs = segmentPts.map(pt => [pt.lat, pt.lon]);
    
    const polylineColor = runner ? runner.color : '#00f0ff';
    const polylineWeight = runner ? 5 : 3;
    const polylineDashArray = runner ? null : '5, 8';
    const polylineOpacity = runner ? 0.9 : 0.6;
    
    const polyline = L.polyline(latlngs, {
      color: polylineColor,
      weight: polylineWeight,
      dashArray: polylineDashArray,
      opacity: polylineOpacity,
      lineJoin: 'round'
    }).addTo(state.map);
    
    const runnerBadge = runner
      ? `<span style="display: inline-flex; align-items: center; gap: 5px;">
           <span style="display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: ${runner.color}; box-shadow: 0 0 6px ${runner.color};"></span>
           <strong style="color: ${runner.color}; font-weight: 600;">${runner.name}</strong>
           <span style="color: #94a3b8; font-size: 0.75rem;">(${formatPace(runner.paceSeconds)}/km)</span>
         </span>`
      : `<span style="color: var(--color-warning); font-style: italic;">Unassigned (5:30/km fallback)</span>`;

    const durationStr = formatDuration(segment.durationSeconds);
    const timeWindowStr = `${formatTime(segment.startTime)} – ${formatTime(segment.endTime)}`;

    const tooltipHtml = `
      <div style="line-height: 1.45; min-width: 190px; max-width: 270px;">
        <div style="font-size: 0.9rem; font-weight: 700; color: #fff; margin-bottom: 5px; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 4px;">
          ${segment.name}
        </div>
        <div style="font-size: 0.8rem; color: #cbd5e1; margin-bottom: 4px; display: flex; justify-content: space-between; gap: 10px;">
          <span>📏 <strong>${segment.distance.toFixed(1)} km</strong></span>
          <span>⛰️ +${Math.round(segment.eleGain)}m / -${Math.round(segment.eleLoss)}m</span>
        </div>
        <div style="font-size: 0.8rem; color: #cbd5e1; margin-bottom: 5px;">
          🏃 ${runnerBadge}
        </div>
        <div style="font-size: 0.75rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 4px;">
          <span>⏱️ ${timeWindowStr}</span>
          <span style="color: #c084fc; font-weight: 600;">${durationStr}</span>
        </div>
      </div>
    `;

    // Bind sticky hover tooltip with rich segment and runner details
    polyline.bindTooltip(tooltipHtml, {
      sticky: true,
      className: 'dark-route-tooltip',
      direction: 'top',
      opacity: 1
    });

    // Hover style effects and bottom-right overlay updates
    polyline.on('mouseover', () => {
      polyline.setStyle({ weight: polylineWeight + 3, opacity: 1 });
      
      // Update details overlay widget
      mapOverlaySegmentName.textContent = segment.name;
      mapOverlaySegmentDetails.textContent = `${segment.distance.toFixed(1)} km | +${Math.round(segment.eleGain)}m / -${Math.round(segment.eleLoss)}m`;
      mapOverlayRunnerName.textContent = runner ? runner.name : 'Unassigned';
      mapOverlayRunnerColor.style.backgroundColor = runner ? runner.color : '#666';
      
      mapOverlayEta.textContent = `${formatTime(segment.startTime)} - ${formatTime(segment.endTime)}`;
      mapOverlay.style.display = 'flex';
    });
    
    polyline.on('mouseout', () => {
      polyline.setStyle({ weight: polylineWeight, opacity: polylineOpacity });
    });
    
    state.mapLayers.routePolylines.push(polyline);
  });
  
  // 4. Draw markers for all waypoints
  // To keep map clutter-free, we render:
  // - Large colored pins for ACTIVE transition points (labels appear on hover)
  // - Small gray circles for INACTIVE waypoints, which can be clicked to activate
  
  // Plot Inactive waypoints
  state.waypoints.forEach(wpt => {
    const isActive = state.activeTransitions.some(w => w.id === wpt.id);
    if (isActive) return; // will handle below
    
    const circle = L.circleMarker([wpt.lat, wpt.lon], {
      radius: 4,
      fillColor: '#94a3b8',
      color: '#475569',
      weight: 1,
      fillOpacity: 0.6
    }).addTo(state.map);
    
    circle.bindTooltip(`<strong>${wpt.name}</strong><br><span style="font-size: 0.75rem; color: #94a3b8;">Click to activate</span>`, {
      className: 'dark-route-tooltip',
      direction: 'top'
    });
    
    // Bind popup for inactive waypoint to allow activating it
    circle.bindPopup(`
      <div style="font-family: var(--font-family); font-size: 0.85rem; color: #f1f5f9; min-width: 180px;">
        <strong style="font-size: 0.95rem; color: #fff;">${wpt.name}</strong><br>
        <span style="color: var(--text-muted); font-size: 0.75rem;">${(wpt.trackIndex / state.trackPoints.length * 211).toFixed(1)} km along route</span><br>
        <p style="margin: 8px 0 0 0; font-size: 0.8rem; font-style: italic; color: #94a3b8;">${wpt.desc || 'No description'}</p>
        <button id="pop-btn-activate-${wpt.id}" class="btn btn-primary btn-small" style="margin-top: 10px; width: 100%;">
          Activate Transition Point
        </button>
      </div>
    `);
    
    circle.on('popupopen', () => {
      const btn = document.getElementById(`pop-btn-activate-${wpt.id}`);
      if (btn) {
        btn.addEventListener('click', async () => {
          state.activeTransitions.push(wpt);
          state.activeTransitions.sort((a, b) => a.trackIndex - b.trackIndex);
          
          const activeIds = state.activeTransitions.map(w => w.id);
          await Storage.saveSetting('activeTransitions', activeIds);
          
          recalculateSchedule();
          drawRouteOnMap();
          state.map.closePopup();
        });
      }
    });
    
    state.mapLayers.markers.push(circle);
  });
  
  // Plot Active waypoints (with custom divIcon pins and hover labels)
  state.activeTransitions.forEach((wpt, idx) => {
    // Find runner assigned to the segment starting at this point
    // The start of segment idx corresponds to activeTransition idx
    const segment = state.segments[idx];
    const runnerId = segment ? state.assignments[segment.id] : null;
    const runner = state.runners.find(r => r.id === runnerId);
    const runnerColor = runner ? runner.color : '#94a3b8';
    
    const icon = L.divIcon({
      className: 'custom-div-icon',
      html: `
        <div class="marker-pin ${runner ? '' : 'inactive'}" style="${runner ? `--color-primary: ${runnerColor}` : ''}"></div>
        <div class="marker-label">${wpt.name.split(',')[0].trim()}</div>
      `,
      iconSize: [30, 42],
      iconAnchor: [15, 42]
    });
    
    const marker = L.marker([wpt.lat, wpt.lon], { icon }).addTo(state.map);
    
    // Popup for active waypoint
    const segmentText = segment ? `
      <div style="margin-top: 6px; font-size: 0.8rem; line-height: 1.45;">
        <div style="color: var(--text-muted); font-size: 0.72rem; text-transform: uppercase;">Next Segment</div>
        <div style="font-weight: 600; color: #fff;">${segment.name} (${segment.distance.toFixed(1)} km)</div>
        <div style="margin-top: 3px;">🏃 <strong>${runner ? runner.name : '<span style="color: var(--color-warning);">Unassigned</span>'}</strong></div>
        <div style="color: var(--text-muted); font-size: 0.75rem; margin-top: 2px;">Departure: <span style="color: var(--color-success); font-weight: 600;">${formatTime(segment.startTime)}</span></div>
      </div>
    ` : '<div style="color: var(--color-success); font-weight: 600; margin-top: 5px;">🏁 Finish Line</div>';
    
    marker.bindPopup(`
      <div style="font-family: var(--font-family); font-size: 0.85rem; color: #f1f5f9; min-width: 190px;">
        <strong style="font-size: 0.95rem; color: var(--color-primary);">${wpt.name}</strong><br>
        <span style="color: var(--text-muted); font-size: 0.75rem;">Transition #${idx + 1} | ${(wpt.trackIndex / state.trackPoints.length * 211).toFixed(1)} km along route</span>
        <hr style="margin: 6px 0; border: none; border-top: 1px solid rgba(255,255,255,0.1);">
        ${segmentText}
        ${(idx > 0 && idx < state.activeTransitions.length - 1) ? `
          <button id="pop-btn-deactivate-${wpt.id}" class="btn btn-danger btn-small" style="margin-top: 10px; width: 100%;">
            Deactivate Transition
          </button>
        ` : ''}
      </div>
    `);
    
    marker.on('popupopen', () => {
      const btn = document.getElementById(`pop-btn-deactivate-${wpt.id}`);
      if (btn) {
        btn.addEventListener('click', async () => {
          // Deactivate
          state.activeTransitions = state.activeTransitions.filter(w => w.id !== wpt.id);
          
          // Re-sort
          state.activeTransitions.sort((a, b) => a.trackIndex - b.trackIndex);
          
          const activeIds = state.activeTransitions.map(w => w.id);
          await Storage.saveSetting('activeTransitions', activeIds);
          
          recalculateSchedule();
          drawRouteOnMap();
          state.map.closePopup();
        });
      }
    });
    
    state.mapLayers.markers.push(marker);
  });
  
  // Center map on route bounds if we just loaded it
  if (state.mapLayers.routePolylines.length > 0 && !state.mapCentered) {
    const bounds = L.featureGroup(state.mapLayers.routePolylines).getBounds();
    state.map.fitBounds(bounds);
    state.mapCentered = true;
  }
}
