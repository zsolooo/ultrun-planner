/**
 * collaboration.js - WebRTC P2P Collaborative Planning Engine for Ultrabalaton Planner
 * Powered by Yjs CRDT + y-webrtc for zero-backend, multi-user real-time synchronization.
 */

import { Y, WebrtcProvider } from './webrtc-vendor.js';

class CollaborationEngine {
  constructor() {
    this.ydoc = null;
    this.provider = null;
    this.roomName = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this.isApplyingRemote = false;
    
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

    // Signaling server endpoints for WebRTC handshake
    this.signalingServers = [
      'wss://signaling.yjs.dev',
      'wss://y-webrtc-signaling-eu.herokuapp.com',
      'wss://y-webrtc-signaling-us.herokuapp.com'
    ];

    // Local peer identifier info
    this.peerInfo = {
      name: this.getStoredNickname() || `Runner #${Math.floor(1000 + Math.random() * 9000)}`,
      color: this.getRandomColor()
    };
  }

  getStoredNickname() {
    try {
      return localStorage.getItem('ub_peer_nickname');
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
   * Connect to a specific room by name
   */
  connect(roomName, initialLocalState = null) {
    if (!roomName || typeof roomName !== 'string') return;
    const cleanRoom = roomName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!cleanRoom) return;

    // If already connected to this exact room, no-op
    if (this.provider && this.roomName === cleanRoom && this.status !== 'disconnected') {
      return;
    }

    // Disconnect any existing session
    this.disconnect();

    this.roomName = cleanRoom;
    this.notifyStatus('connecting');

    // Create a new Yjs document
    this.ydoc = new Y.Doc();
    this.yRunners = this.ydoc.getMap('runners');
    this.yAssignments = this.ydoc.getMap('assignments');
    this.ySettings = this.ydoc.getMap('settings');
    this.yMeta = this.ydoc.getMap('meta');

    // Create WebrtcProvider
    try {
      this.provider = new WebrtcProvider(`ub-planner-${this.roomName}`, this.ydoc, {
        signaling: this.signalingServers,
        password: null,
        awareness: null,
        maxConns: 20 + Math.floor(Math.random() * 15),
        filterBcConns: true,
        peerOpts: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
    } catch (err) {
      console.error('Failed to initialize WebRTC provider:', err);
      this.notifyStatus('disconnected');
      return;
    }

    // Configure presence / awareness
    const awareness = this.provider.awareness;
    awareness.setLocalStateField('user', this.peerInfo);

    awareness.on('change', () => {
      this.notifyPeersChanged();
      if (this.status === 'connecting') {
        this.notifyStatus('connected');
      }
    });

    this.provider.on('status', (event) => {
      console.log('[WebRTC status]', event.status);
      if (event.status === 'connected') {
        this.notifyStatus('connected');
      }
    });

    this.provider.on('synced', (event) => {
      console.log('[WebRTC synced]', event.synced);
      if (event.synced) {
        this.notifyStatus('connected');
        this.handleInitialSync(initialLocalState);
      }
    });

    // Listen to remote changes on Yjs collections
    const handleChange = (events, transaction) => {
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

    // Timeout safety fallback: consider connected if signaling established
    setTimeout(() => {
      if (this.status === 'connecting') {
        this.notifyStatus('connected');
        this.handleInitialSync(initialLocalState);
      }
    }, 2000);
  }

  handleInitialSync(initialLocalState) {
    if (!this.ydoc) return;
    
    const hasRemoteRunners = this.yRunners && this.yRunners.size > 0;
    const hasRemoteAssignments = this.yAssignments && this.yAssignments.size > 0;

    if (!hasRemoteRunners && !hasRemoteAssignments && initialLocalState) {
      // Room is empty; seed it with current local state!
      console.log('[Collaboration] Room is empty. Seeding with local state.');
      this.seedFromLocalState(initialLocalState);
    } else if (hasRemoteRunners || hasRemoteAssignments) {
      // Room already has data; broadcast update to local state
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
      // Seed runners
      if (Array.isArray(state.runners)) {
        state.runners.forEach(runner => {
          this.yRunners.set(runner.id, runner);
        });
      }

      // Seed assignments
      if (state.assignments && typeof state.assignments === 'object') {
        Object.entries(state.assignments).forEach(([segId, runnerId]) => {
          if (runnerId) {
            this.yAssignments.set(segId, runnerId);
          }
        });
      }

      // Seed settings
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
    // Runners
    const runners = [];
    if (this.yRunners) {
      this.yRunners.forEach((runner) => {
        runners.push(runner);
      });
    }

    // Assignments
    const assignments = {};
    if (this.yAssignments) {
      this.yAssignments.forEach((runnerId, segId) => {
        assignments[segId] = runnerId;
      });
    }

    // Settings
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
      // Clean up assignments for this runner
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
      // Delete removed
      this.yRunners.forEach((_, id) => {
        if (!incomingIds.has(id)) {
          this.yRunners.delete(id);
        }
      });
      // Set / update
      runnersList.forEach(runner => {
        this.yRunners.set(runner.id, runner);
      });
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
        if (!incomingKeys.has(key)) {
          this.yAssignments.delete(key);
        }
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
   * Disconnect and clear provider
   */
  disconnect() {
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (e) {
        console.warn('Error destroying provider:', e);
      }
      this.provider = null;
    }
    if (this.ydoc) {
      try {
        this.ydoc.destroy();
      } catch (e) {
        console.warn('Error destroying ydoc:', e);
      }
      this.ydoc = null;
    }
    this.roomName = null;
    this.yRunners = null;
    this.yAssignments = null;
    this.ySettings = null;
    this.yMeta = null;
    this.notifyStatus('disconnected');
    this.notifyPeersChanged();
  }
}

export const Collaboration = new CollaborationEngine();
