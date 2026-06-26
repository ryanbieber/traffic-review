const MPS_TO_MPH = 2.2369362920544;

function centroid(box) {
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
}

function centerDistance(boxA, boxB) {
  const [ax, ay] = centroid(boxA);
  const [bx, by] = centroid(boxB);
  return Math.hypot(ax - bx, ay - by);
}

function estimateSpeed(track, historySeconds) {
  if (track.history.length < 2) {
    return null;
  }

  const newest = track.history[track.history.length - 1];
  let oldest = track.history[0];
  for (let index = track.history.length - 2; index >= 0; index -= 1) {
    const candidate = track.history[index];
    oldest = candidate;
    if (newest.timeS - candidate.timeS >= historySeconds) {
      break;
    }
  }

  const elapsed = newest.timeS - oldest.timeS;
  if (elapsed <= 0) {
    return null;
  }

  const distanceM = Math.hypot(
    newest.worldPoint[0] - oldest.worldPoint[0],
    newest.worldPoint[1] - oldest.worldPoint[1],
  );
  return (distanceM / elapsed) * MPS_TO_MPH;
}

export class VehicleTracker {
  constructor({ historySeconds, speedLimitMph, maxIdleSeconds = 1.5, maxMatchDistance = 140 }) {
    this.historySeconds = historySeconds;
    this.speedLimitMph = speedLimitMph;
    this.maxIdleSeconds = maxIdleSeconds;
    this.maxMatchDistance = maxMatchDistance;
    this.nextTrackId = 1;
    this.tracks = new Map();
  }

  update(detections, timeS, projectPointToWorld) {
    const now = timeS;
    const liveTracks = [...this.tracks.values()].filter(
      (track) => now - track.lastSeenS <= this.maxIdleSeconds,
    );

    const candidates = [];
    liveTracks.forEach((track) => {
      detections.forEach((detection, detectionIndex) => {
        if (track.classId !== detection.classId) {
          return;
        }
        const distance = centerDistance(track.box, detection.box);
        const dynamicThreshold = Math.max(
          this.maxMatchDistance,
          Math.max(track.box.x2 - track.box.x1, track.box.y2 - track.box.y1) * 1.5,
        );
        if (distance <= dynamicThreshold) {
          candidates.push({
            distance,
            trackId: track.id,
            detectionIndex,
          });
        }
      });
    });

    candidates.sort((left, right) => left.distance - right.distance);

    const matchedTrackIds = new Set();
    const matchedDetectionIndexes = new Set();
    for (const candidate of candidates) {
      if (matchedTrackIds.has(candidate.trackId) || matchedDetectionIndexes.has(candidate.detectionIndex)) {
        continue;
      }
      matchedTrackIds.add(candidate.trackId);
      matchedDetectionIndexes.add(candidate.detectionIndex);
      const track = this.tracks.get(candidate.trackId);
      this.#applyDetection(track, detections[candidate.detectionIndex], now, projectPointToWorld);
    }

    detections.forEach((detection, detectionIndex) => {
      if (matchedDetectionIndexes.has(detectionIndex)) {
        return;
      }
      const track = this.#createTrack(detection, now, projectPointToWorld);
      matchedTrackIds.add(track.id);
    });

    for (const [trackId, track] of this.tracks.entries()) {
      if (matchedTrackIds.has(trackId)) {
        continue;
      }
      if (now - track.lastSeenS > this.maxIdleSeconds) {
        this.tracks.delete(trackId);
      }
    }

    return detections.map((detection) => {
      const track = this.tracks.get(detection.trackId);
      return {
        ...detection,
        currentSpeedMph: track.currentSpeedMph,
        peakSpeedMph: track.peakSpeedMph,
        flagged: track.peakSpeedMph >= this.speedLimitMph,
      };
    });
  }

  getSummaryRows() {
    return [...this.tracks.values()]
      .map((track) => ({
        track_id: track.id,
        label: track.label,
        peak_speed_mph: Number(track.peakSpeedMph.toFixed(2)),
        avg_speed_mph: Number(
          (track.speedSamples.length
            ? track.speedSamples.reduce((sum, value) => sum + value, 0) / track.speedSamples.length
            : 0).toFixed(2),
        ),
        frames_seen: track.framesSeen,
        first_seen_s: Number(track.firstSeenS.toFixed(2)),
        last_seen_s: Number(track.lastSeenS.toFixed(2)),
        flagged: track.peakSpeedMph >= this.speedLimitMph,
      }))
      .sort((left, right) => right.peak_speed_mph - left.peak_speed_mph);
  }

  #createTrack(detection, timeS, projectPointToWorld) {
    const track = {
      id: this.nextTrackId,
      classId: detection.classId,
      label: detection.label,
      box: detection.box,
      currentSpeedMph: 0,
      peakSpeedMph: 0,
      speedSamples: [],
      history: [],
      firstSeenS: timeS,
      lastSeenS: timeS,
      framesSeen: 0,
    };
    this.nextTrackId += 1;
    this.tracks.set(track.id, track);
    this.#applyDetection(track, detection, timeS, projectPointToWorld);
    return track;
  }

  #applyDetection(track, detection, timeS, projectPointToWorld) {
    track.box = detection.box;
    track.lastSeenS = timeS;
    track.framesSeen += 1;
    const anchorPoint = [
      (detection.box.x1 + detection.box.x2) / 2,
      detection.box.y2,
    ];
    const worldPoint = projectPointToWorld(anchorPoint);
    track.history.push({ timeS, worldPoint });
    track.history = track.history.filter((entry) => timeS - entry.timeS <= this.historySeconds * 2.5);

    const speed = estimateSpeed(track, this.historySeconds);
    if (speed !== null && Number.isFinite(speed)) {
      track.currentSpeedMph = speed;
      track.speedSamples.push(speed);
      track.peakSpeedMph = Math.max(track.peakSpeedMph, speed);
    }

    detection.trackId = track.id;
  }
}
