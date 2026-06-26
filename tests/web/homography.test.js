import test from "node:test";
import assert from "node:assert/strict";

import { computeHomography, projectPoint } from "../../docs/lib/homography.js";

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
