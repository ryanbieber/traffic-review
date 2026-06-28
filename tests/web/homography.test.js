import test from "node:test";
import assert from "node:assert/strict";

import { computeHomography, invertHomography, projectPoint } from "../../docs/lib/homography.js";

test("computeHomography maps rectangle center into meters", () => {
  const homography = computeHomography(
    [
      [0, 0],
      [200, 0],
      [200, 400],
      [0, 400],
    ],
    2,
    4,
  );

  const point = projectPoint(homography, [100, 200]);
  assert.ok(Math.abs(point[0] - 1) < 1e-6);
  assert.ok(Math.abs(point[1] - 2) < 1e-6);
});

test("invertHomography round-trips projected points", () => {
  const homography = computeHomography(
    [
      [0, 0],
      [200, 0],
      [200, 400],
      [0, 400],
    ],
    2,
    4,
  );
  const inverse = invertHomography(homography);
  const imagePoint = [70, 180];
  const worldPoint = projectPoint(homography, imagePoint);
  const roundTrip = projectPoint(inverse, worldPoint);

  assert.ok(Math.abs(roundTrip[0] - imagePoint[0]) < 1e-6);
  assert.ok(Math.abs(roundTrip[1] - imagePoint[1]) < 1e-6);
});
