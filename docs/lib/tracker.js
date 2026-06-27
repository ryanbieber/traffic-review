function centroid(box) {
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
}

function centerDistance(boxA, boxB) {
  const [ax, ay] = centroid(boxA);
  const [bx, by] = centroid(boxB);
  return Math.hypot(ax - bx, ay - by);
}

function normalizeVector(vector) {
  if (!vector) {
    return null;
  }
  const length = Math.hypot(vector[0], vector[1]);
  if (length < 1e-12) {
    return null;
  }
  return [vector[0] / length, vector[1] / length];
}

function estimateSpeed(track, historySeconds, roadAxis = null) {
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

  let distanceM = null;
  if (newest.worldPoint && oldest.worldPoint) {
    distanceM = Math.hypot(
      newest.worldPoint[0] - oldest.worldPoint[0],
      newest.worldPoint[1] - oldest.worldPoint[1],
    );
  } else {
    const deltaX = newest.anchorPoint[0] - oldest.anchorPoint[0];
    const deltaY = newest.anchorPoint[1] - oldest.anchorPoint[1];
    const axis = normalizeVector(roadAxis);
    const pixelDistance = axis
      ? Math.abs(deltaX * axis[0] + deltaY * axis[1])
      : Math.hypot(deltaX, deltaY);
    const averageScale = (newest.metersPerPixel + oldest.metersPerPixel) / 2;
    distanceM = pixelDistance * averageScale;
  }

  return (distanceM / elapsed) * track.speedMultiplier;
}

export class VehicleTracker {
  constructor({
    historySeconds,
    speedLimitMph,
    speedMultiplier = 2.2369362920544,
    speedUnit = "mph",
    maxIdleSeconds = 1.5,
    maxMatchDistance = 140,
    roadAxis = null,
  }) {
    this.historySeconds = historySeconds;
    this.speedLimitMph = speedLimitMph;
    this.speedMultiplier = speedMultiplier;
    this.speedUnit = speedUnit;
    this.maxIdleSeconds = maxIdleSeconds;
    this.maxMatchDistance = maxMatchDistance;
    this.roadAxis = normalizeVector(roadAxis);
    this.nextTrackId = 1;
    this.tracks = new Map();
    this.completedTracks = [];
  }

  update(detections, timeS, measureDetection) {
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
      this.#applyDetection(track, detections[candidate.detectionIndex], now, measureDetection);
    }

    detections.forEach((detection, detectionIndex) => {
      if (matchedDetectionIndexes.has(detectionIndex)) {
        return;
      }
      const track = this.#createTrack(detection, now, measureDetection);
      matchedTrackIds.add(track.id);
    });

    for (const [trackId, track] of this.tracks.entries()) {
      if (matchedTrackIds.has(trackId)) {
        continue;
      }
      if (now - track.lastSeenS > this.maxIdleSeconds) {
        this.completedTracks.push(track);
        this.tracks.delete(trackId);
      }
    }

    return detections.map((detection) => {
      const track = this.tracks.get(detection.trackId);
      return {
        ...detection,
        currentSpeed: track.currentSpeed,
        peakSpeed: track.peakSpeed,
        speedUnit: this.speedUnit,
        flagged: track.peakSpeed >= this.speedLimitMph,
      };
    });
  }

  getSummaryRows() {
    return [...this.completedTracks, ...this.tracks.values()]
      .map((track) => ({
        track_id: track.id,
        label: track.label,
        peak_speed: Number(track.peakSpeed.toFixed(2)),
        avg_speed: Number(
          (track.speedSamples.length
            ? track.speedSamples.reduce((sum, value) => sum + value, 0) / track.speedSamples.length
            : 0).toFixed(2),
        ),
        speed_unit: this.speedUnit,
        frames_seen: track.framesSeen,
        first_seen_s: Number(track.firstSeenS.toFixed(2)),
        last_seen_s: Number(track.lastSeenS.toFixed(2)),
        flagged: track.peakSpeed >= this.speedLimitMph,
      }))
      .sort((left, right) => right.peak_speed - left.peak_speed);
  }

  #createTrack(detection, timeS, measureDetection) {
    const track = {
      id: this.nextTrackId,
      classId: detection.classId,
      label: detection.label,
      box: detection.box,
      currentSpeed: 0,
      peakSpeed: 0,
      speedSamples: [],
      history: [],
      firstSeenS: timeS,
      lastSeenS: timeS,
      framesSeen: 0,
      speedMultiplier: this.speedMultiplier,
    };
    this.nextTrackId += 1;
    this.tracks.set(track.id, track);
    this.#applyDetection(track, detection, timeS, measureDetection);
    return track;
  }

  #applyDetection(track, detection, timeS, measureDetection) {
    track.box = detection.box;
    track.lastSeenS = timeS;
    track.framesSeen += 1;
    const measurement = measureDetection(detection);
    track.history.push({
      timeS,
      anchorPoint: measurement.anchorPoint,
      metersPerPixel: measurement.metersPerPixel,
      worldPoint: measurement.worldPoint || null,
    });
    track.history = track.history.filter((entry) => timeS - entry.timeS <= this.historySeconds * 2.5);

    const speed = estimateSpeed(track, this.historySeconds, this.roadAxis);
    if (speed !== null && Number.isFinite(speed)) {
      track.currentSpeed = speed;
      track.speedSamples.push(speed);
      track.peakSpeed = Math.max(track.peakSpeed, speed);
    }

    detection.trackId = track.id;
    detection.worldPoint = measurement.worldPoint || null;
  }
}
