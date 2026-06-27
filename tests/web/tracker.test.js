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
