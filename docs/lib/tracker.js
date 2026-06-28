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

function fitSlope(samples, valueAccessor) {
  if (samples.length < 2) {
    return null;
  }

  const baseTime = samples[0].timeS;
  let count = 0;
  let sumTime = 0;
  let sumValue = 0;
  let sumTimeSq = 0;
  let sumTimeValue = 0;

  for (const sample of samples) {
    const timeOffset = sample.timeS - baseTime;
    const value = valueAccessor(sample);
    if (!Number.isFinite(timeOffset) || !Number.isFinite(value)) {
      continue;
    }
    count += 1;
    sumTime += timeOffset;
    sumValue += value;
    sumTimeSq += timeOffset * timeOffset;
    sumTimeValue += timeOffset * value;
  }

  if (count < 2) {
    return null;
  }

  const denominator = (count * sumTimeSq) - (sumTime * sumTime);
  if (Math.abs(denominator) < 1e-12) {
    return null;
  }

  return ((count * sumTimeValue) - (sumTime * sumValue)) / denominator;
}

function estimateSpeed(track, historySeconds, roadAxis = null) {
  if (track.history.length < 2) {
    return null;
  }

  const newest = track.history[track.history.length - 1];
  const relevant = track.history.filter((entry) => newest.timeS - entry.timeS <= historySeconds * 2.5);
  const worldPoints = relevant.filter((entry) => Array.isArray(entry.worldPoint) && entry.worldPoint.every(Number.isFinite));
  const worldSpanS = worldPoints.length >= 2 ? worldPoints[worldPoints.length - 1].timeS - worldPoints[0].timeS : 0;

  const worldSlope = worldPoints.length >= 2 && worldSpanS >= Math.min(0.2, historySeconds)
    ? fitSlope(worldPoints, (entry) => entry.worldPoint[1])
    : null;
  if (worldSlope !== null && Number.isFinite(worldSlope)) {
    return Math.abs(worldSlope) * track.speedMultiplier;
  }

  if (roadAxis) {
    const cumulativeSamples = [];
    let cumulativeDistanceM = 0;
    cumulativeSamples.push({ timeS: relevant[0].timeS, distanceM: 0 });

    for (let index = 1; index < relevant.length; index += 1) {
      const previous = relevant[index - 1];
      const current = relevant[index];
      if (!Number.isFinite(current.metersPerPixel) || !Number.isFinite(previous.metersPerPixel)) {
        continue;
      }
      const deltaX = current.anchorPoint[0] - previous.anchorPoint[0];
      const deltaY = current.anchorPoint[1] - previous.anchorPoint[1];
      const axis = normalizeVector(roadAxis);
      const pixelDistance = axis
        ? Math.abs(deltaX * axis[0] + deltaY * axis[1])
        : Math.hypot(deltaX, deltaY);
      const averageScale = (current.metersPerPixel + previous.metersPerPixel) / 2;
      const segmentDistanceM = pixelDistance * averageScale;
      if (Number.isFinite(segmentDistanceM) && segmentDistanceM >= 0) {
        cumulativeDistanceM += segmentDistanceM;
      }
      cumulativeSamples.push({
        timeS: current.timeS,
        distanceM: cumulativeDistanceM,
      });
    }

    const cumulativeSlope = fitSlope(cumulativeSamples, (entry) => entry.distanceM);
    if (cumulativeSlope !== null && Number.isFinite(cumulativeSlope)) {
      return Math.abs(cumulativeSlope) * track.speedMultiplier;
    }
  }

  let distanceM = null;
  let oldest = relevant[0] || track.history[0];
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

  const useWorldDistance = newest.worldPoint && oldest.worldPoint && elapsed >= Math.min(0.2, historySeconds);
  if (useWorldDistance) {
    distanceM = Math.hypot(
      newest.worldPoint[0] - oldest.worldPoint[0],
      newest.worldPoint[1] - oldest.worldPoint[1],
    );
  } else {
    if (!Number.isFinite(newest.metersPerPixel) || !Number.isFinite(oldest.metersPerPixel)) {
      return null;
    }
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
        displayLabel: track.displayLabel,
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
        display_label: track.displayLabel,
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
      displayLabel: `${detection.label} #${this.nextTrackId}`,
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
