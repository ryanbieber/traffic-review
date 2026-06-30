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
  [0.33, 0.67, 1].forEach((timeS) => {
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
    { timeS: 0.33, x: 14, worldPoint: [0, 10.03134] },
    { timeS: 0.67, x: 18, worldPoint: [0, 20.36666] },
    { timeS: 1, x: 22, worldPoint: [0, 30.398] },
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
    { timeS: 0.33, x: 14, worldPoint: [4, 10.03134] },
    { timeS: 0.67, x: 18, worldPoint: [8, 20.36666] },
    { timeS: 1, x: 22, worldPoint: [12, 30.398] },
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
    { timeS: 0.33, x: 14, worldPoint: [10.03134, 4] },
    { timeS: 0.67, x: 18, worldPoint: [20.36666, 8] },
    { timeS: 1, x: 22, worldPoint: [30.398, 12] },
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
