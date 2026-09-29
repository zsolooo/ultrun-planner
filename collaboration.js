/**
 * collaboration.js - WebRTC P2P Collaborative Planning Engine for Ultrabalaton Planner
 * Powered by Yjs CRDT + y-webrtc for zero-backend, multi-user real-time synchronization.
 */

import { Y, WebrtcProvider, rooms } from './webrtc-vendor.js';

class CollaborationEngine {
  constructor() {
    this.ydoc = null;
    this.provider = null;
    this.roomName = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this.isApplyingRemote = false;
    // Prevent auto-reconnect after explicit user disconnect
    this.disconnectedByUser = false;

    // Yjs data structures
    this.yRunners = null;
    this.yAssignments = null;
    this.ySettings = null;
    this.yMeta = null;

    // Event listeners
    this.listeners = {
      status: [],
      remoteUpdate: [],
      peers: []
    };

    // Live signaling server endpoints for WebRTC handshake
    // Prioritizes dedicated Fly.io instance; allows localStorage override
    this.signalingServers = this.getSignalingServers();

    // Local peer identifier info
    this.peerInfo = {
      name: this.getStoredNickname() || `Runner #${Math.floor(1000 + Math.random() * 9000)}`,
      color: this.getRandomColor()
    };
  }

  getSignalingServers() {
    try {
      const stored = localStorage.getItem('ub_signaling_servers');
      // If stored value contains obsolete servers or is invalid, purge it
      if (stored && (stored.includes('y-webrtc') || !stored.trim())) {
        localStorage.removeItem('ub_signaling_servers');
      } else if (stored && stored.trim()) {
        const list = stored.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length > 0) return list;
      }
    } catch (e) {}
    // Single dedicated signaling address only
    return ['wss://ultrun-signaling.fly.dev'];
  }

  setSignalingServers(servers) {
    if (Array.isArray(servers) && servers.length > 0) {
      this.signalingServers = servers;
      try {
        localStorage.setItem('ub_signaling_servers', servers.join(', '));
      } catch (e) {}
    } else {
      try {
        localStorage.removeItem('ub_signaling_servers');
      } catch (e) {}
      this.signalingServers = this.getSignalingServers();
    }
  }

  getStoredNickname() {
    try {
      return localStorage.getItem('ub_peer_nickname') || null;
    } catch (e) {
      return null;
    }
  }

  setNickname(name) {
    if (!name || !name.trim()) return;
    this.peerInfo.name = name.trim();
    try {
      localStorage.setItem('ub_peer_nickname', this.peerInfo.name);
    } catch (e) {}

    if (this.provider && this.provider.awareness) {
      this.provider.awareness.setLocalStateField('user', this.peerInfo);
    }
    this.notifyPeersChanged();
  }

  getRandomColor() {
    const colors = ['#00f0ff', '#39ff14', '#ff00ff', '#ffeb3b', '#bd00ff', '#ff7300', '#ff2a85', '#0088ff'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // Subscribe to collaboration events
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  notifyStatus(status) {
    this.status = status;
    const peers = this.getConnectedPeers();
    this.listeners.status.forEach(cb => {
      try { cb({ status: this.status, roomName: this.roomName, peerCount: peers.length, peers }); } catch (e) { console.error(e); }
    });
  }

  notifyPeersChanged() {
    const peers = this.getConnectedPeers();
    this.listeners.peers.forEach(cb => {
      try { cb({ peerCount: peers.length, peers }); } catch (e) { console.error(e); }
    });
  }

  getConnectedPeers() {
    if (!this.provider || !this.provider.awareness) return [];
    const states = this.provider.awareness.getStates();
    const peers = [];
    states.forEach((state, clientID) => {
      if (state && state.user) {
        peers.push({
          clientID,
          isSelf: clientID === this.ydoc.clientID,
          name: state.user.name || 'Anonymous',
          color: state.user.color || '#00f0ff'
        });
      }
    });
    return peers;
  }

  /**
   * Connect to a specific room by name.
   */
  connect(roomName, initialLocalState = null) {
    if (!roomName || typeof roomName !== 'string') return;
    const cleanRoom = roomName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!cleanRoom) return;

    // If user explicitly disconnected and the same room is being reconnected
    // (e.g. from hashchange), skip unless it is a NEW room.
    if (this.disconnectedByUser && this.status === 'disconnected') {
      // Only block reconnect to the same room; allow a fresh different room.
      console.log('[Collaboration] Auto-reconnect suppressed after user disconnect.');
      return;
    }

    // If already connected or connecting to this exact room, no-op
    if (this.provider && this.roomName === cleanRoom && this.status !== 'disconnected') {
      return;
    }

    // Clear the user-disconnect flag on explicit new connect
    this.disconnectedByUser = false;

    // Tear down any existing session fully before creating a new one
    this._destroyProvider();

    this.roomName = cleanRoom;
    this.notifyStatus('connecting');

    // Create a new Yjs document
    this.ydoc = new Y.Doc();
    this.yRunners = this.ydoc.getMap('runners');
    this.yAssignments = this.ydoc.getMap('assignments');
    this.ySettings = this.ydoc.getMap('settings');
    this.yMeta = this.ydoc.getMap('meta');

    // Create WebrtcProvider.
    // NOTE: Do NOT pass awareness: null – that disables it entirely.
    // Do NOT pass password: null – some builds treat it as an invalid option.
    try {
      this.provider = new WebrtcProvider(`ub-planner-${this.roomName}`, this.ydoc, {
        signaling: this.signalingServers,
        maxConns: 20 + Math.floor(Math.random() * 15),
        filterBcConns: true,
        peerOpts: {
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' }
            ]
          }
        }
      });
      console.log(`[Collaboration] WebRTC Provider initialized for room "${this.roomName}" using signaling:`, this.signalingServers);
    } catch (err) {
      console.error('[Collaboration] Failed to initialize WebRTC provider:', err);
      this._destroyProvider();
      this.notifyStatus('disconnected');
      return;
    }

    // Configure presence / awareness (awareness is always non-null here)
    const awareness = this.provider.awareness;
    awareness.setLocalStateField('user', this.peerInfo);

    awareness.on('change', () => {
      this.notifyPeersChanged();
      // Only mark connected when we can see at least one REMOTE peer.
      // states always includes the local client, so size > 1 means another peer is present.
      // Solo users (first person in room) reach 'connected' via the 3s fallback timeout instead.
      if (this.status === 'connecting') {
        const states = awareness.getStates();
        if (states.size > 1) {
          this.notifyStatus('connected');
        }
      }
    });

    this.provider.on('status', (event) => {
      console.log('[WebRTC status]', event.connected ? 'connected' : 'disconnected');
      if (event.connected && this.status !== 'connected') {
        this.notifyStatus('connected');
      }
    });

    this.provider.on('synced', (event) => {
      console.log('[WebRTC synced]', event.synced);
      if (event.synced) {
        // Always run initial sync on synced — regardless of current status.
        // This is the only reliable moment when remote Yjs data is guaranteed present.
        if (this.status !== 'connected') {
          this.notifyStatus('connected');
        }
        this.handleInitialSync(initialLocalState);
      }
    });

    // When a new peer joins late, re-seed the room with local state
    // so the late joiner receives current data.
    this.provider.on('peers', ({ added, removed }) => {
      if (added && added.length > 0 && this.status === 'connected') {
        console.log(`[Collaboration] ${added.length} new peer(s) joined; re-seeding room.`);
        // Only re-seed if WE own the data (i.e. local state has runners).
        const remoteHasData = this.yRunners && this.yRunners.size > 0;
        if (!remoteHasData && initialLocalState && initialLocalState.runners && initialLocalState.runners.length > 0) {
          this.seedFromLocalState(initialLocalState);
        }
      }
    });

    // Listen to remote changes on Yjs collections
    const handleChange = (_events, transaction) => {
      // Ignore if change originated from our own client transaction
      if (transaction.local) return;

      this.isApplyingRemote = true;
      try {
        const payload = this.exportCurrentYjsState();
        this.listeners.remoteUpdate.forEach(cb => {
          try { cb(payload); } catch (e) { console.error('Remote update listener error:', e); }
        });
      } finally {
        this.isApplyingRemote = false;
      }
    };

    this.yRunners.observe(handleChange);
    this.yAssignments.observe(handleChange);
    this.ySettings.observe(handleChange);

    // Timeout safety fallback: mark as connected and attempt sync even if 'synced'
    // event never fires (solo mode, no peers, or stale signaling).
    this.connectionTimeoutId = setTimeout(() => {
      if (this.provider && this.status === 'connecting') {
        console.log('[Collaboration] Timeout – no synced event. Marking connected and seeding.');
        this.notifyStatus('connected');
        // Only seed if room appears empty — don't overwrite existing remote data.
        const hasRemote = (this.yRunners && this.yRunners.size > 0) || (this.yAssignments && this.yAssignments.size > 0);
        if (!hasRemote) {
          this.seedFromLocalState(initialLocalState);
        } else {
          this.handleInitialSync(initialLocalState);
        }
      }
    }, 3000);

    // Cancel fallback timeout if synced event fires first
    this.provider.once('synced', () => {
      if (this.connectionTimeoutId) {
        clearTimeout(this.connectionTimeoutId);
        this.connectionTimeoutId = null;
      }
    });
  }

  handleInitialSync(initialLocalState) {
    if (!this.ydoc) return;

    const hasRemoteRunners = this.yRunners && this.yRunners.size > 0;
    const hasRemoteAssignments = this.yAssignments && this.yAssignments.size > 0;

    if (!hasRemoteRunners && !hasRemoteAssignments && initialLocalState) {
      console.log('[Collaboration] Room is empty. Seeding with local state.');
      this.seedFromLocalState(initialLocalState);
    } else if (hasRemoteRunners || hasRemoteAssignments) {
      console.log('[Collaboration] Room has data. Syncing remote data into local state.');
      const payload = this.exportCurrentYjsState();
      this.listeners.remoteUpdate.forEach(cb => {
        try { cb(payload); } catch (e) { console.error(e); }
      });
    }
  }

  seedFromLocalState(state) {
    if (!this.ydoc || !state) return;
    this.ydoc.transact(() => {
      if (Array.isArray(state.runners)) {
        state.runners.forEach(runner => {
          this.yRunners.set(runner.id, runner);
        });
      }
      if (state.assignments && typeof state.assignments === 'object') {
        Object.entries(state.assignments).forEach(([segId, runnerId]) => {
          if (runnerId) this.yAssignments.set(segId, runnerId);
        });
      }
      if (state.startTime) {
        const startStr = state.startTime instanceof Date ? state.startTime.toISOString() : state.startTime;
        this.ySettings.set('startTime', startStr);
      }
      if (Array.isArray(state.activeTransitions)) {
        const ids = state.activeTransitions.map(w => w.id || w);
        this.ySettings.set('activeTransitions', ids);
      }
      this.yMeta.set('updatedAt', new Date().toISOString());
      this.yMeta.set('seededBy', this.peerInfo.name);
    });
  }

  exportCurrentYjsState() {
    const runners = [];
    if (this.yRunners) {
      this.yRunners.forEach(runner => runners.push(runner));
    }

    const assignments = {};
    if (this.yAssignments) {
      this.yAssignments.forEach((runnerId, segId) => {
        assignments[segId] = runnerId;
      });
    }

    let startTime = null;
    let activeTransitions = null;
    if (this.ySettings) {
      startTime = this.ySettings.get('startTime') || null;
      activeTransitions = this.ySettings.get('activeTransitions') || null;
    }

    return {
      runners,
      assignments,
      startTime,
      activeTransitions,
      updatedAt: this.yMeta ? this.yMeta.get('updatedAt') : null
    };
  }

  // --- Methods to update Yjs from local user actions ---

  updateRunner(runner) {
    if (!this.ydoc || !this.yRunners || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      this.yRunners.set(runner.id, runner);
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  deleteRunner(runnerId) {
    if (!this.ydoc || !this.yRunners || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      this.yRunners.delete(runnerId);
      if (this.yAssignments) {
        this.yAssignments.forEach((assignedRunnerId, segId) => {
          if (assignedRunnerId === runnerId) {
            this.yAssignments.delete(segId);
          }
        });
      }
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  saveRunnersBatch(runnersList) {
    if (!this.ydoc || !this.yRunners || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      const incomingIds = new Set(runnersList.map(r => r.id));
      this.yRunners.forEach((_, id) => {
        if (!incomingIds.has(id)) this.yRunners.delete(id);
      });
      runnersList.forEach(runner => this.yRunners.set(runner.id, runner));
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  updateAssignment(segmentId, runnerId) {
    if (!this.ydoc || !this.yAssignments || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      if (runnerId) {
        this.yAssignments.set(segmentId, runnerId);
      } else {
        this.yAssignments.delete(segmentId);
      }
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  saveAssignmentsBatch(assignmentsMap) {
    if (!this.ydoc || !this.yAssignments || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      const incomingKeys = new Set(Object.keys(assignmentsMap));
      this.yAssignments.forEach((_, key) => {
        if (!incomingKeys.has(key)) this.yAssignments.delete(key);
      });
      Object.entries(assignmentsMap).forEach(([segId, runnerId]) => {
        if (runnerId) {
          this.yAssignments.set(segId, runnerId);
        } else {
          this.yAssignments.delete(segId);
        }
      });
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  updateSetting(key, value) {
    if (!this.ydoc || !this.ySettings || this.isApplyingRemote) return;
    this.ydoc.transact(() => {
      this.ySettings.set(key, value);
      if (this.yMeta) this.yMeta.set('updatedAt', new Date().toISOString());
    });
  }

  /**
   * Internal: destroy provider and ydoc without updating disconnectedByUser flag.
   */
  _destroyProvider() {
    if (this.connectionTimeoutId) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
    if (this.provider) {
      try {
        this.provider.disconnect();
        this.provider.destroy();
      } catch (e) { console.warn('Error destroying provider:', e); }
      this.provider = null;
    }
    // Clean up room registry synchronously
    if (this.roomName) {
      try {
        rooms.delete(`ub-planner-${this.roomName}`);
      } catch (e) {}
    }
    if (this.ydoc) {
      try { this.ydoc.destroy(); } catch (e) { console.warn('Error destroying ydoc:', e); }
      this.ydoc = null;
    }
    this.yRunners = null;
    this.yAssignments = null;
    this.ySettings = null;
    this.yMeta = null;
  }

  /**
   * Public: disconnect called by user. Sets flag to suppress URL-hash auto-reconnect.
   */
  disconnect() {
    this.disconnectedByUser = true;
    this.roomName = null;
    this._destroyProvider();
    this.notifyStatus('disconnected');
    this.notifyPeersChanged();
  }
}

export const Collaboration = new CollaborationEngine();
