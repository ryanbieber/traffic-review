function centroid(box) {
  return [
    (box.x1 + box.x2) / 2,
    (box.y1 + box.y2) / 2,
  ];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < 1e-12) {
    return null;
  }
  return [vector[0] / length, vector[1] / length];
}

export function estimateRoadAxis(samples) {
  const points = [];
  samples.forEach((sample) => {
    (sample.detections || []).forEach((detection) => {
      if (!Number.isFinite(detection.score) || detection.score < 0.2) {
        return;
      }
      points.push(centroid(detection.box));
    });
  });

  if (points.length < 3) {
    return null;
  }

  const mean = points.reduce(
    (accumulator, point) => [accumulator[0] + point[0], accumulator[1] + point[1]],
    [0, 0],
  ).map((value) => value / points.length);

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  points.forEach(([x, y]) => {
    const dx = x - mean[0];
    const dy = y - mean[1];
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  });

  const trace = sxx + syy;
  const discriminant = Math.max(0, trace * trace * 0.25 - (sxx * syy - sxy * sxy));
  const lambda1 = trace * 0.5 + Math.sqrt(discriminant);
  const lambda2 = trace * 0.5 - Math.sqrt(discriminant);
  const axis = normalize([lambda1 - syy, sxy]) || normalize([sxy, lambda1 - sxx]);
  if (!axis) {
    return null;
  }

  const angleDeg = (Math.atan2(axis[1], axis[0]) * 180) / Math.PI;
  const confidence = lambda1 > 0 ? Math.max(0, Math.min(1, 1 - lambda2 / lambda1)) : 0;

  return {
    center: mean,
    axis,
    angleDeg: ((angleDeg % 180) + 180) % 180,
    confidence,
    points,
  };
}
