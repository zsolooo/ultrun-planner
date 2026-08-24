/**
 * gpx-parser.js - GPX parsing, segmentation, and generation utilities
 */

// Haversine formula to compute distance between two coordinates in km
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parses raw GPX XML string into tracks and waypoints
 */
export function parseGPX(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  
  // Parse waypoints (POIs)
  const wpts = [];
  const wptNodes = xmlDoc.getElementsByTagName('wpt');
  for (let i = 0; i < wptNodes.length; i++) {
    const node = wptNodes[i];
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    const nameNode = node.getElementsByTagName('name')[0];
    const descNode = node.getElementsByTagName('desc')[0];
    
    wpts.push({
      id: `wpt_${i}`,
      lat,
      lon,
      name: nameNode ? nameNode.textContent.trim() : `Waypoint ${i}`,
      desc: descNode ? descNode.textContent.trim() : ''
    });
  }

  // Parse track points
  const trkpts = [];
  const trkptNodes = xmlDoc.getElementsByTagName('trkpt');
  let cumulativeDist = 0;
  
  for (let i = 0; i < trkptNodes.length; i++) {
    const node = trkptNodes[i];
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    
    const eleNode = node.getElementsByTagName('ele')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : 0;
    
    if (i > 0) {
      const prev = trkpts[i - 1];
      const dist = haversineDistance(prev.lat, prev.lon, lat, lon);
      cumulativeDist += dist;
    }
    
    trkpts.push({
      index: i,
      lat,
      lon,
      ele,
      dist: cumulativeDist // cumulative distance in km
    });
  }

  return {
    waypoints: wpts,
    trackPoints: trkpts
  };
}

/**
 * Projects a waypoint onto the track, returning the index of the closest track point
 */
export function projectWaypointToTrack(wpt, trackPoints) {
  let minIdx = 0;
  let minDist = Infinity;
  
  for (let i = 0; i < trackPoints.length; i++) {
    const pt = trackPoints[i];
    const d = haversineDistance(wpt.lat, wpt.lon, pt.lat, pt.lon);
    if (d < minDist) {
      minDist = d;
      minIdx = i;
    }
  }
  return { index: minIdx, distance: minDist };
}

/**
 * Auto-detects active team transition points from the waypoints.
 * Waypoints containing Hungarian terms for team transition points: "csapat váltópont", "csapat vf" or "váltópont".
 */
export function detectTeamTransitions(waypoints) {
  const keywords = ['csapat váltópont', 'csapat váltó', 'csapat vf', 'váltópont', 'váltó és frissítő'];
  return waypoints.filter(wpt => {
    const text = (wpt.name + ' ' + wpt.desc).toLowerCase();
    return keywords.some(keyword => text.includes(keyword));
  });
}

/**
 * Generates segments from sorted active transition points
 */
export function generateSegments(trackPoints, activeTransitions) {
  const segments = [];
  
  for (let i = 0; i < activeTransitions.length - 1; i++) {
    const startWpt = activeTransitions[i];
    const endWpt = activeTransitions[i + 1];
    
    const startIndex = startWpt.trackIndex;
    const endIndex = endWpt.trackIndex;
    
    const segmentPoints = trackPoints.slice(startIndex, endIndex + 1);
    
    // Calculate distance
    const startDist = trackPoints[startIndex].dist;
    const endDist = trackPoints[endIndex].dist;
    const distance = endDist - startDist;
    
    // Calculate elevation gain & loss
    let eleGain = 0;
    let eleLoss = 0;
    for (let j = 1; j < segmentPoints.length; j++) {
      const diff = segmentPoints[j].ele - segmentPoints[j - 1].ele;
      if (diff > 0) eleGain += diff;
      else eleLoss += Math.abs(diff);
    }
    
    segments.push({
      id: `seg_${i}`,
      name: `${startWpt.name.split(',')[0]} → ${endWpt.name.split(',')[0]}`,
      startIndex,
      endIndex,
      startWpt,
      endWpt,
      distance, // km
      eleGain, // meters
      eleLoss // meters
    });
  }
  
  return segments;
}

/**
 * Generates a smartwatch-compatible GPX string for a range of track points and included waypoints
 */
export function generateGPX(runName, trackPoints, waypointsInRange) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<gpx version="1.1" creator="Ultrabalaton Team Schedule Planner" \n';
  xml += '     xmlns="http://www.topografix.com/GPX/1/1" \n';
  xml += '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" \n';
  xml += '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
  
  // Metadata
  xml += '  <metadata>\n';
  xml += `    <name><![CDATA[${runName}]]></name>\n`;
  xml += `    <desc><![CDATA[Exported run from Ultrabalaton Team Planner]]></desc>\n`;
  xml += `    <time>${new Date().toISOString()}</time>\n`;
  xml += '  </metadata>\n';

  // Waypoints along the run
  waypointsInRange.forEach(wpt => {
    xml += `  <wpt lat="${wpt.lat}" lon="${wpt.lon}">\n`;
    xml += `    <name><![CDATA[${wpt.name}]]></name>\n`;
    if (wpt.desc) {
      xml += `    <desc><![CDATA[${wpt.desc}]]></desc>\n`;
    }
    xml += '  </wpt>\n';
  });

  // Track points
  xml += '  <trk>\n';
  xml += `    <name><![CDATA[${runName}]]></name>\n`;
  xml += '    <trkseg>\n';
  
  trackPoints.forEach(pt => {
    xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">\n`;
    xml += `        <ele>${pt.ele.toFixed(2)}</ele>\n`;
    xml += '      </trkpt>\n';
  });

  xml += '    </trkseg>\n';
  xml += '  </trk>\n';
  xml += '</gpx>\n';

  return xml;
}
