/**
 * storage.js - IndexedDB state manager for Ultrabalaton Team Planner
 */
const DB_NAME = 'UltrabalatonPlannerDB';
const DB_VERSION = 1;

let dbInstance = null;

function getDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Store raw GPX route string and metadata
      if (!db.objectStoreNames.contains('route')) {
        db.createObjectStore('route', { keyPath: 'id' });
      }
      
      // Store runners list
      if (!db.objectStoreNames.contains('runners')) {
        db.createObjectStore('runners', { keyPath: 'id' });
      }
      
      // Store general settings (start time, etc.)
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Store assignments (segmentIndex -> runnerId)
      if (!db.objectStoreNames.contains('assignments')) {
        db.createObjectStore('assignments', { keyPath: 'segmentId' });
      }
    };
  });
}

function getObject(storeName, key) {
  return getDB().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

function setObject(storeName, value) {
  return getDB().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

function getAllObjects(storeName) {
  return getDB().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

function deleteObject(storeName, key) {
  return getDB().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

function clearStore(storeName) {
  return getDB().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

export const Storage = {
  // Route storage
  saveRouteGPX(gpxXmlText) {
    return setObject('route', { id: 'active_route', xml: gpxXmlText, updatedAt: new Date().toISOString() });
  },
  
  getRouteGPX() {
    return getObject('route', 'active_route').then(res => res ? res.xml : null);
  },

  hasRoute() {
    return getObject('route', 'active_route').then(res => !!res);
  },

  deleteRoute() {
    return deleteObject('route', 'active_route');
  },

  // Runners storage
  saveRunners(runnersList) {
    return clearStore('runners').then(() => {
      if (runnersList.length === 0) return Promise.resolve();
      return getDB().then((db) => {
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('runners', 'readwrite');
          const store = transaction.objectStore('runners');
          
          runnersList.forEach((runner) => {
            store.put(runner);
          });
          
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      });
    });
  },

  getRunners() {
    return getAllObjects('runners');
  },

  // Assignments storage
  saveAssignments(assignmentsMap) {
    // assignmentsMap is an array of { segmentId, runnerId }
    return clearStore('assignments').then(() => {
      const list = Object.entries(assignmentsMap).map(([segId, runnerId]) => ({
        segmentId: segId,
        runnerId: runnerId
      }));
      if (list.length === 0) return Promise.resolve();
      
      return getDB().then((db) => {
        return new Promise((resolve, reject) => {
          const transaction = db.transaction('assignments', 'readwrite');
          const store = transaction.objectStore('assignments');
          
          list.forEach((item) => {
            store.put(item);
          });
          
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      });
    });
  },

  getAssignments() {
    return getAllObjects('assignments').then((list) => {
      const map = {};
      list.forEach((item) => {
        map[item.segmentId] = item.runnerId;
      });
      return map;
    });
  },

  // Settings storage
  saveSetting(key, value) {
    return setObject('settings', { key, value });
  },

  getSetting(key, defaultValue = null) {
    return getObject('settings', key).then(res => res ? res.value : defaultValue);
  },

  // Bulk Backup and Restore
  async exportBackup() {
    const runners = await this.getRunners();
    const assignments = await this.getAssignments();
    const startTime = await this.getSetting('startTime', '2026-05-16T08:00');
    const activeTransitions = await this.getSetting('activeTransitions', null);
    const customWaypoints = await this.getSetting('customWaypoints', []);
    const hasRoute = await this.hasRoute();
    let routeXml = null;
    if (hasRoute) {
      routeXml = await this.getRouteGPX();
    }
    
    return {
      version: 1,
      exportDate: new Date().toISOString(),
      runners,
      assignments,
      startTime,
      activeTransitions,
      customWaypoints,
      routeXml
    };
  },

  async importBackup(backupData) {
    if (!backupData || typeof backupData !== 'object') {
      throw new Error('Invalid backup data format');
    }

    if (backupData.runners) {
      await this.saveRunners(backupData.runners);
    }
    if (backupData.assignments) {
      await this.saveAssignments(backupData.assignments);
    }
    if (backupData.startTime) {
      await this.saveSetting('startTime', backupData.startTime);
    }
    if (backupData.activeTransitions !== undefined) {
      await this.saveSetting('activeTransitions', backupData.activeTransitions);
    }
    if (backupData.customWaypoints) {
      await this.saveSetting('customWaypoints', backupData.customWaypoints);
    }
    if (backupData.routeXml) {
      await this.saveRouteGPX(backupData.routeXml);
    }
  },

  async clearAll() {
    await clearStore('route');
    await clearStore('runners');
    await clearStore('assignments');
    await clearStore('settings');
  }
};
