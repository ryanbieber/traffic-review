import test from "node:test";
import assert from "node:assert/strict";

import { VehicleTracker } from "../../docs/lib/tracker.js";

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
  const detectionsB = [
    {
      classId: 5,
      label: "bus",
      score: 0.92,
      box: { x1: 40, y1: 30, x2: 140, y2: 220 },
    },
  ];

  const first = tracker.update(detectionsA, 0, measure);
  const second = tracker.update(detectionsB, 1, measure);

  assert.equal(first[0].trackId, second[0].trackId);
  assert.equal(Math.round(second[0].currentSpeed), 0);
  const summary = tracker.getSummaryRows();
  assert.equal(summary.length, 1);
  assert.equal(summary[0].label, "bus");
  assert.equal(summary[0].display_label, "bus #1");
  assert.equal(summary[0].speed_unit, "mph");
});

test("VehicleTracker prefers projected world distance over pixel scale", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: detection.box.x1 < 20 ? [0, 0] : [0, 30.398],
  });

  const first = tracker.update([
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

  assert.equal(first[0].trackId, second[0].trackId);
  assert.ok(Math.abs(second[0].currentSpeed - 68) < 0.1);
});

test("VehicleTracker uses road-length world motion and ignores lateral jitter", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: [detection.box.x1 < 20 ? 0 : 12, detection.box.x1 < 20 ? 0 : 30.398],
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

  assert.ok(Math.abs(second[0].currentSpeed - 68) < 0.1);
});

test("VehicleTracker uses the dominant world-motion axis when the road is rotated", () => {
  const tracker = new VehicleTracker({
    historySeconds: 0.5,
    speedLimitMph: 35,
  });

  const measure = (detection) => ({
    anchorPoint: [(detection.box.x1 + detection.box.x2) / 2, detection.box.y2],
    metersPerPixel: 0.001,
    worldPoint: [detection.box.x1 < 20 ? 0 : 30.398, detection.box.x1 < 20 ? 0 : 12],
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

  assert.ok(Math.abs(second[0].currentSpeed - 68) < 0.1);
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

  assert.equal(second[0].currentSpeed, 0);
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

  assert.ok(second[0].currentSpeed < 100);
});
