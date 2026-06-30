import test from "node:test";
import assert from "node:assert/strict";

import { VehicleTracker } from "../../docs/lib/tracker.js";

function detectionAt({ x = 10, y = 30, worldPoint = null } = {}) {
  return {
    classId: 2,
    label: "car",
    score: 0.92,
    box: { x1: x, y1: y, x2: x + 100, y2: y + 100 },
    worldPoint,
  };
}

function updateSingleTrack(tracker, samples, measure) {
  let result = null;
  samples.forEach((sample) => {
    result = tracker.update([detectionAt(sample)], sample.timeS, measure);
  });
  return result[0];
}

test("VehicleTracker keeps a stable track id and estimates zero speed for static boxes", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.05,
  });
  const detectionsA = [
    {
      classId: 5,
      label: "bus",
      score: 0.91,
      box: { x1: 40, y1: 30, x2: 140, y2: 220 },
    },
  ];
  const first = tracker.update(detectionsA, 0, measure);
  let second = null;
  [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach((timeS) => {
    second = tracker.update([
      {
        classId: 5,
        label: "bus",
        score: 0.92,
        box: { x1: 40, y1: 30, x2: 140, y2: 220 },
      },
    ], timeS, measure);
  });

  assert.equal(first[0].trackId, second[0].trackId);
  assert.equal(second[0].speedStatus, "estimated");
  assert.equal(Math.round(second[0].currentSpeed), 0);
  const summary = tracker.getSummaryRows();
  assert.equal(summary.length, 1);
  assert.equal(summary[0].label, "bus");
  assert.equal(summary[0].display_label, "bus #1");
  assert.equal(summary[0].speed_unit, "mph");
  assert.equal(summary[0].speed_status, "estimated");
  assert.match(summary[0].trust_reason, /Trusted/);
  assert.equal(summary[0].avg_speed, 0);
});

test("VehicleTracker prefers projected world distance over pixel scale", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: detection.worldPoint,
  });

  const current = updateSingleTrack(tracker, [
    { timeS: 0, x: 10, worldPoint: [0, 0] },
    { timeS: 0.25, x: 13, worldPoint: [0, 7.5995] },
    { timeS: 0.5, x: 16, worldPoint: [0, 15.199] },
    { timeS: 0.75, x: 19, worldPoint: [0, 22.7985] },
    { timeS: 1, x: 22, worldPoint: [0, 30.398] },
    { timeS: 1.25, x: 25, worldPoint: [0, 37.9975] },
    { timeS: 1.5, x: 28, worldPoint: [0, 45.597] },
    { timeS: 1.75, x: 31, worldPoint: [0, 53.1965] },
    { timeS: 2, x: 34, worldPoint: [0, 60.796] },
  ], measure);

  assert.equal(current.speedStatus, "estimated");
  assert.ok(Math.abs(current.currentSpeed - 68) < 0.1);
});

test("VehicleTracker uses road-length world motion and ignores lateral jitter", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: detection.worldPoint,
  });

  const current = updateSingleTrack(tracker, [
    { timeS: 0, x: 10, worldPoint: [0, 0] },
    { timeS: 0.25, x: 13, worldPoint: [3, 7.5995] },
    { timeS: 0.5, x: 16, worldPoint: [6, 15.199] },
    { timeS: 0.75, x: 19, worldPoint: [9, 22.7985] },
    { timeS: 1, x: 22, worldPoint: [12, 30.398] },
    { timeS: 1.25, x: 25, worldPoint: [15, 37.9975] },
    { timeS: 1.5, x: 28, worldPoint: [18, 45.597] },
    { timeS: 1.75, x: 31, worldPoint: [21, 53.1965] },
    { timeS: 2, x: 34, worldPoint: [24, 60.796] },
  ], measure);

  assert.ok(Math.abs(current.currentSpeed - 68) < 0.1);
});

test("VehicleTracker uses the dominant world-motion axis when the road is rotated", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: detection.worldPoint,
  });

  const current = updateSingleTrack(tracker, [
    { timeS: 0, x: 10, worldPoint: [0, 0] },
    { timeS: 0.25, x: 13, worldPoint: [7.5995, 3] },
    { timeS: 0.5, x: 16, worldPoint: [15.199, 6] },
    { timeS: 0.75, x: 19, worldPoint: [22.7985, 9] },
    { timeS: 1, x: 22, worldPoint: [30.398, 12] },
    { timeS: 1.25, x: 25, worldPoint: [37.9975, 15] },
    { timeS: 1.5, x: 28, worldPoint: [45.597, 18] },
    { timeS: 1.75, x: 31, worldPoint: [53.1965, 21] },
    { timeS: 2, x: 34, worldPoint: [60.796, 24] },
  ], measure);

  assert.ok(Math.abs(current.currentSpeed - 68) < 0.1);
});

test("VehicleTracker does not invent speed without calibrated scale", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: null,
  });

  tracker.update([
    {
      classId: 2,
      label: "car",
      score: 0.91,
      box: { x1: 10, y1: 30, x2: 110, y2: 130 },
    },
  ], 0, measure);
  const second = tracker.update([
    {
      classId: 2,
      label: "car",
      score: 0.92,
      box: { x1: 20, y1: 30, x2: 120, y2: 130 },
    },
  ], 1, measure);

  assert.equal(second[0].currentSpeed, null);
  assert.equal(second[0].speedStatus, "not_enough_info");
  const summary = tracker.getSummaryRows();
  assert.match(summary[0].trust_reason, /valid speed samples/);
});

test("VehicleTracker ignores world-point spikes on very short tracks", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.05,
    worldPoint: [detection.box.x1 < 20 ? 0 : 0, detection.box.x1 < 20 ? 0 : 25],
  });

  tracker.update([
    {
      classId: 2,
      label: "car",
      score: 0.91,
      box: { x1: 10, y1: 30, x2: 110, y2: 130 },
    },
  ], 0, measure);
  const second = tracker.update([
    {
      classId: 2,
      label: "car",
      score: 0.92,
      box: { x1: 20, y1: 30, x2: 120, y2: 130 },
    },
  ], 0.05, measure);

  assert.equal(second[0].currentSpeed, null);
  assert.equal(second[0].speedStatus, "not_enough_info");
});
