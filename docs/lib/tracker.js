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

const MIN_REPORTABLE_SPEED_SAMPLES = 8;
const MIN_REPORTABLE_TRACK_SECONDS = 1.25;
const MAX_REASONABLE_SPEED_MPH = 140;
const SPEED_SMOOTHING_ALPHA = 0.35;

function isReasonableSpeed(speedMph) {
  return Number.isFinite(speedMph) && speedMph >= 0 && speedMph <= MAX_REASONABLE_SPEED_MPH;
}

function mean(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundedSpeed(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function getTrackDuration(track) {
  const elapsed = track.lastSeenS - track.firstSeenS;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function getSpeedTrust(track) {
  const durationS = getTrackDuration(track);
  const validSpeedSamples = track.smoothedSpeedSamples.length;
  const reasons = [];

  if (durationS < MIN_REPORTABLE_TRACK_SECONDS) {
    reasons.push(`Seen for ${durationS.toFixed(2)}s, needs ${MIN_REPORTABLE_TRACK_SECONDS.toFixed(2)}s`);
  }

  if (validSpeedSamples < MIN_REPORTABLE_SPEED_SAMPLES) {
    reasons.push(`Only ${validSpeedSamples} valid speed samples, needs ${MIN_REPORTABLE_SPEED_SAMPLES}`);
  }

  if (track.rejectedSpeedSamples > 0) {
    reasons.push(`${track.rejectedSpeedSamples} speed samples rejected as implausible`);
  }

  if (!track.speedSamples.length && durationS >= MIN_REPORTABLE_TRACK_SECONDS) {
    reasons.push("No calibrated motion samples were available");
  }

  if (reasons.length) {
    return {
      reportable: false,
      status: "not_enough_info",
      reason: reasons.join("; "),
      durationS,
      validSpeedSamples,
      rejectedSpeedSamples: track.rejectedSpeedSamples,
    };
  }

  return {
    reportable: true,
    status: "estimated",
    reason: `Trusted: ${durationS.toFixed(2)}s observed with ${validSpeedSamples} valid speed samples`,
    durationS,
    validSpeedSamples,
    rejectedSpeedSamples: track.rejectedSpeedSamples,
  };
}

function representativeSmoothedSpeed(track) {
  return maxRollingMedian(track.smoothedSpeedSamples, 5) ??
    percentile(track.smoothedSpeedSamples, 0.75) ??
    mean(track.smoothedSpeedSamples);
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

function estimateWindowedWorldAxisSpeed(worldPoints, speedMultiplier) {
  const axisIndex = chooseDominantWorldAxisIndex(worldPoints);
  if (axisIndex === null) {
    return null;
  }

  const windowSpeeds = [];
  for (let endIndex = 1; endIndex < worldPoints.length; endIndex += 1) {
    for (let startIndex = 0; startIndex < endIndex; startIndex += 1) {
      const start = worldPoints[startIndex];
      const end = worldPoints[endIndex];
      const elapsed = end.timeS - start.timeS;
      if (!Number.isFinite(elapsed) || elapsed < 1.2) {
        continue;
      }
      const distanceM = Math.abs(end.worldPoint[axisIndex] - start.worldPoint[axisIndex]);
      const speedMph = (distanceM / elapsed) * speedMultiplier;
      if (isReasonableSpeed(speedMph)) {
        windowSpeeds.push({ elapsed, speedMph });
      }
    }
  }

  if (!windowSpeeds.length) {
    return null;
  }

  const maxElapsed = Math.max(...windowSpeeds.map((sample) => sample.elapsed));
  const longWindowSpeeds = windowSpeeds
    .filter((sample) => sample.elapsed >= maxElapsed * 0.8)
    .map((sample) => sample.speedMph);
  return median(longWindowSpeeds);
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
      const trust = getSpeedTrust(track);
      return {
        ...detection,
        displayLabel: track.displayLabel,
        currentSpeed: trust.reportable ? track.currentSpeed : null,
        peakSpeed: trust.reportable ? track.peakSpeed : null,
        speedUnit: this.speedUnit,
        speedStatus: trust.status,
        trustReason: trust.reason,
        flagged: trust.reportable && track.peakSpeed >= this.speedLimitMph,
      };
    });
  }

  getSummaryRows() {
    return [...this.completedTracks, ...this.tracks.values()]
      .map((track) => {
        const trust = getSpeedTrust(track);
        return {
          ...(() => {
            if (!trust.reportable) {
              return {
                avg_speed: null,
                peak_speed: null,
                speed_status: trust.status,
              };
            }
            const roadAxisSpeed = estimateRoadAxisSpeed(track.history, this.roadAxis, track.speedMultiplier);
            const worldPoints = track.history.filter((entry) => Array.isArray(entry.worldPoint) && entry.worldPoint.every(Number.isFinite));
            const windowedWorldSpeed = estimateWindowedWorldAxisSpeed(worldPoints, track.speedMultiplier);
            const sampleAverage = roundedSpeed(representativeSmoothedSpeed(track));
            if (
              windowedWorldSpeed !== null &&
              Number.isFinite(windowedWorldSpeed) &&
              isReasonableSpeed(windowedWorldSpeed) &&
              windowedWorldSpeed > sampleAverage * 1.35 &&
              windowedWorldSpeed > 8
            ) {
              return {
                avg_speed: roundedSpeed(windowedWorldSpeed),
                peak_speed: roundedSpeed(Math.max(track.peakSpeed, windowedWorldSpeed)),
                speed_status: trust.status,
              };
            }
            if (
              !this.preferWorldMotion &&
              roadAxisSpeed !== null &&
              Number.isFinite(roadAxisSpeed) &&
              isReasonableSpeed(roadAxisSpeed) &&
              roadAxisSpeed > sampleAverage * 1.35 &&
              roadAxisSpeed > 8
            ) {
              return {
                avg_speed: roundedSpeed(roadAxisSpeed),
                peak_speed: roundedSpeed(Math.max(track.peakSpeed, roadAxisSpeed)),
                speed_status: trust.status,
              };
            }
            return {
              avg_speed: sampleAverage,
              peak_speed: roundedSpeed(track.peakSpeed),
              speed_status: trust.status,
            };
          })(),
          track_id: track.id,
          label: track.label,
          display_label: track.displayLabel,
          speed_unit: this.speedUnit,
          frames_seen: track.framesSeen,
          first_seen_s: Number(track.firstSeenS.toFixed(2)),
          last_seen_s: Number(track.lastSeenS.toFixed(2)),
          track_duration_s: Number(trust.durationS.toFixed(2)),
          speed_sample_count: trust.validSpeedSamples,
          rejected_speed_sample_count: trust.rejectedSpeedSamples,
          trust_reason: trust.reason,
          flagged: trust.reportable && track.peakSpeed >= this.speedLimitMph,
        };
      })
      .sort((left, right) => (right.peak_speed ?? -1) - (left.peak_speed ?? -1));
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
      smoothedSpeedSamples: [],
      rejectedSpeedSamples: 0,
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
    if (isReasonableSpeed(speed)) {
      track.speedSamples.push(speed);
      const previousSmoothed = track.smoothedSpeedSamples[track.smoothedSpeedSamples.length - 1];
      const smoothedSpeed = Number.isFinite(previousSmoothed)
        ? (previousSmoothed * (1 - SPEED_SMOOTHING_ALPHA)) + (speed * SPEED_SMOOTHING_ALPHA)
        : speed;
      track.smoothedSpeedSamples.push(smoothedSpeed);
      track.currentSpeed = smoothedSpeed;
      track.peakSpeed = Math.max(track.peakSpeed, smoothedSpeed);
    } else if (speed !== null && Number.isFinite(speed)) {
      track.rejectedSpeedSamples += 1;
    }

    detection.trackId = track.id;
    detection.worldPoint = measurement.worldPoint || null;
  }
}
