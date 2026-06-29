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

function median(values) {
  if (!values.length) {
    return null;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }
  return ordered[middle];
}

function percentile(values, ratio) {
  if (!values.length) {
    return null;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const index = Math.min(ordered.length - 1, Math.floor(clampedRatio * ordered.length));
  return ordered[index];
}

function maxRollingMedian(values, windowSize) {
  if (values.length < windowSize || windowSize < 1) {
    return null;
  }
  let best = null;
  for (let index = 0; index <= values.length - windowSize; index += 1) {
    const windowMedian = median(values.slice(index, index + windowSize));
    if (windowMedian === null) {
      continue;
    }
    if (best === null || windowMedian > best) {
      best = windowMedian;
    }
  }
  return best;
}

function chooseDominantWorldAxisIndex(worldPoints) {
  if (worldPoints.length < 2) {
    return null;
  }
  const first = worldPoints[0].worldPoint;
  const last = worldPoints[worldPoints.length - 1].worldPoint;
  const spanX = Math.abs(last[0] - first[0]);
  const spanY = Math.abs(last[1] - first[1]);
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) {
    return null;
  }
  return spanY >= spanX ? 1 : 0;
}

function estimateWorldAxisSpeed(worldPoints) {
  const axisIndex = chooseDominantWorldAxisIndex(worldPoints);
  if (axisIndex === null) {
    return null;
  }

  const segmentSpeeds = [];
  for (let index = 1; index < worldPoints.length; index += 1) {
    const previous = worldPoints[index - 1];
    const current = worldPoints[index];
    const deltaTime = current.timeS - previous.timeS;
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      continue;
    }
    const delta = current.worldPoint[axisIndex] - previous.worldPoint[axisIndex];
    if (!Number.isFinite(delta)) {
      continue;
    }
    segmentSpeeds.push(Math.abs(delta) / deltaTime);
  }

  if (segmentSpeeds.length < 1) {
    return null;
  }

  return median(segmentSpeeds);
}

function estimateRoadAxisSpeed(samples, roadAxis, speedMultiplier) {
  if (!roadAxis || samples.length < 2) {
    return null;
  }
  const axis = normalizeVector(roadAxis);
  if (!axis) {
    return null;
  }

  const segmentSpeeds = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const deltaTime = current.timeS - previous.timeS;
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      continue;
    }
    if (
      !Array.isArray(previous.anchorPoint) ||
      !Array.isArray(current.anchorPoint) ||
      !Number.isFinite(previous.metersPerPixel) ||
      !Number.isFinite(current.metersPerPixel)
    ) {
      continue;
    }
    const deltaX = current.anchorPoint[0] - previous.anchorPoint[0];
    const deltaY = current.anchorPoint[1] - previous.anchorPoint[1];
    const pixelDistance = Math.abs(deltaX * axis[0] + deltaY * axis[1]);
    const averageScale = (current.metersPerPixel + previous.metersPerPixel) / 2;
    const segmentSpeed = (pixelDistance * averageScale / deltaTime) * speedMultiplier;
    if (Number.isFinite(segmentSpeed) && segmentSpeed >= 0) {
      segmentSpeeds.push(segmentSpeed);
    }
  }

  if (segmentSpeeds.length < 1) {
    return null;
  }

  return maxRollingMedian(segmentSpeeds, 3) ?? percentile(segmentSpeeds, 0.9);
}

function estimateSpeed(track, historySeconds, roadAxis = null, preferWorldMotion = false) {
  if (track.history.length < 2) {
    return null;
  }

  const newest = track.history[track.history.length - 1];
  const relevant = track.history.filter((entry) => newest.timeS - entry.timeS <= historySeconds * 2.5);
  const worldPoints = relevant.filter((entry) => Array.isArray(entry.worldPoint) && entry.worldPoint.every(Number.isFinite));
  const worldSpanS = worldPoints.length >= 2 ? worldPoints[worldPoints.length - 1].timeS - worldPoints[0].timeS : 0;

  const worldSpeed = worldPoints.length >= 2 && worldSpanS >= Math.min(0.2, historySeconds)
    ? estimateWorldAxisSpeed(worldPoints)
    : null;
  const roadSpeed = preferWorldMotion ? null : estimateRoadAxisSpeed(relevant, roadAxis, track.speedMultiplier);
  if (worldSpeed !== null && Number.isFinite(worldSpeed)) {
    const worldSpeedMph = Math.abs(worldSpeed) * track.speedMultiplier;
    if (!preferWorldMotion && roadSpeed !== null && Number.isFinite(roadSpeed) && roadSpeed > worldSpeedMph * 1.35) {
      return roadSpeed;
    }
    return worldSpeedMph;
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
    preferWorldMotion = false,
  }) {
    this.historySeconds = historySeconds;
    this.speedLimitMph = speedLimitMph;
    this.speedMultiplier = speedMultiplier;
    this.speedUnit = speedUnit;
    this.maxIdleSeconds = maxIdleSeconds;
    this.maxMatchDistance = maxMatchDistance;
    this.roadAxis = normalizeVector(roadAxis);
    this.preferWorldMotion = Boolean(preferWorldMotion);
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
        ...(() => {
          const first = track.history[0] || null;
          const last = track.history[track.history.length - 1] || null;
          const elapsed = first && last ? last.timeS - first.timeS : null;
          let worldAverage = null;
          if (
            first &&
            last &&
            elapsed !== null &&
            Number.isFinite(elapsed) &&
            elapsed > 0 &&
            Array.isArray(first.worldPoint) &&
            Array.isArray(last.worldPoint) &&
            first.worldPoint.every(Number.isFinite) &&
            last.worldPoint.every(Number.isFinite)
          ) {
            const axisIndex = Math.abs(last.worldPoint[1] - first.worldPoint[1]) >= Math.abs(last.worldPoint[0] - first.worldPoint[0])
              ? 1
              : 0;
            const worldDistanceM = Math.abs(last.worldPoint[axisIndex] - first.worldPoint[axisIndex]);
            if (Number.isFinite(worldDistanceM)) {
              worldAverage = Number(((worldDistanceM / elapsed) * track.speedMultiplier).toFixed(2));
            }
          }
          const roadAxisSpeed = estimateRoadAxisSpeed(track.history, this.roadAxis, track.speedMultiplier);
          const fallbackAverage = track.speedSamples.length
            ? track.speedSamples.reduce((sum, value) => sum + value, 0) / track.speedSamples.length
            : 0;
          const sampleAverage = Number(fallbackAverage.toFixed(2));
          const baselineAverage = Number.isFinite(worldAverage) ? worldAverage : sampleAverage;
          if (
            !this.preferWorldMotion &&
            roadAxisSpeed !== null &&
            Number.isFinite(roadAxisSpeed) &&
            roadAxisSpeed > baselineAverage * 1.35 &&
            roadAxisSpeed > 8
          ) {
            return {
              avg_speed: Number(roadAxisSpeed.toFixed(2)),
            };
          }
          return {
            avg_speed: baselineAverage,
          };
        })(),
        track_id: track.id,
        label: track.label,
        display_label: track.displayLabel,
        peak_speed: Number(track.peakSpeed.toFixed(2)),
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

    const speed = estimateSpeed(track, this.historySeconds, this.roadAxis, this.preferWorldMotion);
    if (speed !== null && Number.isFinite(speed)) {
      track.currentSpeed = speed;
      track.speedSamples.push(speed);
      track.peakSpeed = Math.max(track.peakSpeed, speed);
    }

    detection.trackId = track.id;
    detection.worldPoint = measurement.worldPoint || null;
  }
}
