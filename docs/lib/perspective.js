import { computeHomography, projectPoint as projectHomographyPoint } from "./homography.js";

const DEFAULT_LANE_WIDTH_M = 3.6576;
const DEFAULT_DASH_LENGTH_M = 3.048;
const DEFAULT_DASH_GAP_M = 9.144;
const DEFAULT_DASH_CYCLE_M = DEFAULT_DASH_LENGTH_M + DEFAULT_DASH_GAP_M;
const ANALYSIS_ROWS = [0.55, 0.62, 0.69, 0.76, 0.83, 0.9];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }
  return ordered[middle];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < 1e-12) {
    return null;
  }
  return [vector[0] / length, vector[1] / length];
}

function toGrayscale(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildMask(width, height, detections) {
  const mask = new Uint8Array(width * height);
  detections.forEach((detection) => {
    const x1 = clamp(Math.floor(detection.box.x1) - 8, 0, width - 1);
    const y1 = clamp(Math.floor(detection.box.y1) - 8, 0, height - 1);
    const x2 = clamp(Math.ceil(detection.box.x2) + 8, 0, width - 1);
    const y2 = clamp(Math.ceil(detection.box.y2) + 8, 0, height - 1);
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        mask[y * width + x] = 1;
      }
    }
  });
  return mask;
}

function sampleFrame(frameCanvas, detections) {
  const baseWidth = frameCanvas.width || 1;
  const baseHeight = frameCanvas.height || 1;
  const sampleWidth = Math.min(420, baseWidth);
  const sampleHeight = Math.max(1, Math.round((baseHeight / baseWidth) * sampleWidth));
  const scratch = document.createElement("canvas");
  scratch.width = sampleWidth;
  scratch.height = sampleHeight;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  context.drawImage(frameCanvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const mask = buildMask(sampleWidth, sampleHeight, detections.map((detection) => ({
    box: {
      x1: detection.box.x1 * (sampleWidth / baseWidth),
      y1: detection.box.y1 * (sampleHeight / baseHeight),
      x2: detection.box.x2 * (sampleWidth / baseWidth),
      y2: detection.box.y2 * (sampleHeight / baseHeight),
    },
  })));

  const points = [];
  const rowIndexes = ANALYSIS_ROWS.map((fraction) => clamp(Math.round(sampleHeight * fraction), 2, sampleHeight - 3));
  const rowRadius = Math.max(1, Math.round(sampleHeight * 0.008));

  rowIndexes.forEach((row) => {
    const rowValues = [];
    let sum = 0;
    let sumSquares = 0;
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (row * sampleWidth + x) * 4;
      if (mask[row * sampleWidth + x]) {
        continue;
      }
      const gray = toGrayscale(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      rowValues.push(gray);
      sum += gray;
      sumSquares += gray * gray;
    }

    if (rowValues.length < 12) {
      return;
    }

    const rowMean = sum / rowValues.length;
    const variance = Math.max(0, sumSquares / rowValues.length - rowMean * rowMean);
    const rowStd = Math.sqrt(variance);
    const brightThreshold = rowMean + Math.max(16, rowStd * 0.8);
    const edgeThreshold = Math.max(12, rowStd * 0.9);

    let runStart = null;
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (row * sampleWidth + x) * 4;
      if (mask[row * sampleWidth + x]) {
        if (runStart !== null) {
          addBrightRun(points, pixels, mask, sampleWidth, sampleHeight, runStart, x - 1, row, brightThreshold);
          runStart = null;
        }
        continue;
      }
      const gray = toGrayscale(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (gray >= brightThreshold) {
        if (runStart === null) {
          runStart = x;
        }
      } else if (runStart !== null) {
        addBrightRun(points, pixels, mask, sampleWidth, sampleHeight, runStart, x - 1, row, brightThreshold);
        runStart = null;
      }
    }
    if (runStart !== null) {
      addBrightRun(points, pixels, mask, sampleWidth, sampleHeight, runStart, sampleWidth - 1, row, brightThreshold);
    }

    addRoadEdgePoints(points, pixels, mask, sampleWidth, sampleHeight, row, edgeThreshold);

    // Add a second row near this one to stabilize lane-marking fits on broken lines.
    const nextRow = clamp(row + rowRadius, 0, sampleHeight - 1);
    if (nextRow !== row) {
      addRoadEdgePoints(points, pixels, mask, sampleWidth, sampleHeight, nextRow, edgeThreshold * 0.95);
    }
  });

  return {
    width: sampleWidth,
    height: sampleHeight,
    sourceWidth: baseWidth,
    sourceHeight: baseHeight,
    scaleX: sampleWidth / baseWidth,
    scaleY: sampleHeight / baseHeight,
    points,
    pixels,
    mask,
  };
}

function addBrightRun(points, pixels, mask, width, height, x1, x2, y, threshold) {
  const minWidth = Math.max(2, Math.round(width * 0.004));
  const maxWidth = Math.max(minWidth + 2, Math.round(width * 0.08));
  const runWidth = x2 - x1 + 1;
  if (runWidth < minWidth || runWidth > maxWidth) {
    return;
  }

  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  let sumBright = 0;
  for (let x = x1; x <= x2; x += 1) {
    const offset = (y * width + x) * 4;
    if (mask[y * width + x]) {
      continue;
    }
    const gray = toGrayscale(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    if (gray < threshold) {
      continue;
    }
    const localContrast = gray - threshold;
    const chroma = Math.max(
      Math.abs(pixels[offset] - pixels[offset + 1]),
      Math.abs(pixels[offset + 1] - pixels[offset + 2]),
      Math.abs(pixels[offset] - pixels[offset + 2]),
    );
    if (chroma > 70) {
      continue;
    }
    const pointWeight = 1 + localContrast / 64 + clamp((64 - chroma) / 128, 0, 0.5);
    weight += pointWeight;
    sumX += x * pointWeight;
    sumY += y * pointWeight;
    sumBright += gray * pointWeight;
  }

  if (weight <= 0.5) {
    return;
  }

  points.push({
    x: sumX / weight,
    y: sumY / weight,
    weight,
    brightness: sumBright / weight,
    source: "marking",
  });
}

function addRoadEdgePoints(points, pixels, mask, width, height, y, threshold) {
  const leftBoundary = Math.max(2, Math.floor(width / 3));
  const rightBoundary = Math.min(width - 3, Math.ceil((width * 2) / 3));

  let bestLeft = null;
  let bestRight = null;

  for (let x = 1; x < width - 1; x += 1) {
    if (mask[y * width + x]) {
      continue;
    }
    const offset = (y * width + x) * 4;
    const gray = toGrayscale(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    const leftGray = toGrayscale(
      pixels[offset - 4],
      pixels[offset - 3],
      pixels[offset - 2],
    );
    const rightGray = toGrayscale(
      pixels[offset + 4],
      pixels[offset + 5],
      pixels[offset + 6],
    );
    const leftGradient = gray - leftGray;
    const rightGradient = gray - rightGray;
    const gradient = Math.abs(leftGradient) + Math.abs(rightGradient);
    if (gradient < threshold) {
      continue;
    }
    const candidate = {
      x,
      y,
      weight: 0.55 + gradient / 140,
      brightness: gray,
      source: "edge",
    };

    if (x <= leftBoundary) {
      if (!bestLeft || candidate.weight > bestLeft.weight) {
        bestLeft = candidate;
      }
    } else if (x >= rightBoundary) {
      if (!bestRight || candidate.weight > bestRight.weight) {
        bestRight = candidate;
      }
    }
  }

  if (bestLeft) {
    points.push(bestLeft);
  }
  if (bestRight) {
    points.push(bestRight);
  }
}

function fitWeightedLine(points) {
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  if (totalWeight <= 0) {
    return null;
  }
  const weightedY = points.reduce((sum, point) => sum + point.y * point.weight, 0) / totalWeight;
  const weightedX = points.reduce((sum, point) => sum + point.x * point.weight, 0) / totalWeight;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const centeredY = point.y - weightedY;
    numerator += point.weight * centeredY * (point.x - weightedX);
    denominator += point.weight * centeredY * centeredY;
  }
  if (Math.abs(denominator) < 1e-8) {
    return null;
  }
  const slope = numerator / denominator;
  const intercept = weightedX - slope * weightedY;
  return { slope, intercept };
}

function lineResidual(line, point) {
  return Math.abs(point.x - (line.slope * point.y + line.intercept));
}

function fitRoadLines(points, width, height) {
  const remaining = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ ...point }));
  const lines = [];
  const tolerance = Math.max(3.5, width * 0.018);

  while (remaining.length >= 3 && lines.length < 6) {
    let best = null;
    for (let left = 0; left < remaining.length - 1; left += 1) {
      for (let right = left + 1; right < remaining.length; right += 1) {
        const pointA = remaining[left];
        const pointB = remaining[right];
        const deltaY = pointB.y - pointA.y;
        if (Math.abs(deltaY) < 6) {
          continue;
        }
        const slope = (pointB.x - pointA.x) / deltaY;
        if (!Number.isFinite(slope) || Math.abs(slope) > 12) {
          continue;
        }
        const intercept = pointA.x - slope * pointA.y;
        const candidate = { slope, intercept };
        const inliers = [];
        let support = 0;
        for (const point of remaining) {
          const residual = lineResidual(candidate, point);
          if (residual <= tolerance) {
            inliers.push(point);
            support += point.weight;
          }
        }
        if (support < 2.2) {
          continue;
        }
        if (!best || support > best.support) {
          best = { ...candidate, support, inliers };
        }
      }
    }

    if (!best) {
      break;
    }

    const refined = fitWeightedLine(best.inliers) || best;
    const refinedInliers = remaining.filter((point) => lineResidual(refined, point) <= tolerance);
    const refinedSupport = refinedInliers.reduce((sum, point) => sum + point.weight, 0);
    if (refinedSupport < 2.2) {
      break;
    }

    lines.push({
      slope: refined.slope,
      intercept: refined.intercept,
      support: refinedSupport,
      inliers: refinedInliers,
      direction: normalize([refined.slope, 1]),
      angleDeg: (Math.atan2(1, refined.slope) * 180) / Math.PI,
    });

    const nextRemaining = [];
    for (const point of remaining) {
      if (lineResidual(refined, point) > tolerance) {
        nextRemaining.push(point);
      }
    }
    remaining.splice(0, remaining.length, ...nextRemaining);
  }

  return lines.sort((left, right) => right.support - left.support);
}

function intersectLines(lineA, lineB) {
  const denominator = lineA.slope - lineB.slope;
  if (Math.abs(denominator) < 1e-6) {
    return null;
  }
  const y = (lineB.intercept - lineA.intercept) / denominator;
  const x = lineA.slope * y + lineA.intercept;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return [x, y];
}

function estimateVanishingPoint(lines, width, height) {
  const intersections = [];
  for (let left = 0; left < lines.length - 1; left += 1) {
    for (let right = left + 1; right < lines.length; right += 1) {
      const intersection = intersectLines(lines[left], lines[right]);
      if (!intersection) {
        continue;
      }
      const [x, y] = intersection;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      const angleDelta = Math.abs(lines[left].angleDeg - lines[right].angleDeg);
      if (angleDelta < 4) {
        continue;
      }
      const support = lines[left].support * lines[right].support * clamp(angleDelta / 30, 0.25, 1.5);
      intersections.push({
        x,
        y,
        support,
      });
    }
  }

  if (!intersections.length) {
    return {
      x: width / 2,
      y: height * 0.1,
      confidence: 0.1,
    };
  }

  const totalSupport = intersections.reduce((sum, item) => sum + item.support, 0);
  const x = intersections.reduce((sum, item) => sum + item.x * item.support, 0) / totalSupport;
  const y = intersections.reduce((sum, item) => sum + item.y * item.support, 0) / totalSupport;
  const spread = Math.sqrt(
    intersections.reduce((sum, item) => sum + item.support * ((item.x - x) ** 2 + (item.y - y) ** 2), 0) /
      totalSupport,
  );
  return {
    x,
    y,
    confidence: clamp((intersections.length / Math.max(1, lines.length)) * (1 / (1 + spread / 240)), 0.15, 0.95),
  };
}

function sampleLineProfile(frame, line, yStart, yEnd) {
  const { width, height, pixels, mask } = frame;
  const step = Math.max(1, Math.round(height / 140));
  const radius = Math.max(1, Math.round(width * 0.007));
  const values = [];

  for (let y = clamp(Math.round(yStart), 0, height - 1); y <= clamp(Math.round(yEnd), 0, height - 1); y += step) {
    const x = line.slope * y + line.intercept;
    if (!Number.isFinite(x) || x < 0 || x >= width) {
      continue;
    }
    const center = Math.round(x);
    let sum = 0;
    let count = 0;
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const sampleX = center + offsetX;
      if (sampleX < 0 || sampleX >= width) {
        continue;
      }
      if (mask[y * width + sampleX]) {
        continue;
      }
      const pixelOffset = (y * width + sampleX) * 4;
      sum += toGrayscale(pixels[pixelOffset], pixels[pixelOffset + 1], pixels[pixelOffset + 2]);
      count += 1;
    }
    if (count > 0) {
      values.push({ y, brightness: sum / count });
    }
  }
  return values;
}

function estimateDashScale(frame, line, vanishingPoint, dashCycleMeters = DEFAULT_DASH_CYCLE_M) {
  const startY = Math.max(vanishingPoint.y + 20, frame.height * 0.45);
  const profile = sampleLineProfile(frame, line, startY, frame.height - 4);
  if (profile.length < 6) {
    return null;
  }

  const brightnessValues = profile.map((item) => item.brightness);
  const profileMean = mean(brightnessValues);
  const profileStd = Math.sqrt(
    Math.max(0, brightnessValues.reduce((sum, value) => sum + (value - profileMean) ** 2, 0) / brightnessValues.length),
  );
  const threshold = profileMean + Math.max(10, profileStd * 0.55);

  const peaks = [];
  let run = null;
  for (let index = 0; index < profile.length; index += 1) {
    const value = profile[index];
    if (value.brightness >= threshold) {
      if (!run) {
        run = {
          start: index,
          end: index,
          brightness: value.brightness,
        };
      }
      run.end = index;
      run.brightness = Math.max(run.brightness, value.brightness);
    } else if (run) {
      peaks.push(run);
      run = null;
    }
  }
  if (run) {
    peaks.push(run);
  }

  if (peaks.length < 2) {
    return null;
  }

  const centers = peaks.map((peak) => {
    const centerIndex = (peak.start + peak.end) / 2;
    const y = profile[Math.round(centerIndex)]?.y ?? profile[peak.start].y;
    return y;
  });
  const diffs = [];
  for (let index = 1; index < centers.length; index += 1) {
    const diff = centers[index] - centers[index - 1];
    if (diff > 4) {
      diffs.push(diff);
    }
  }
  if (!diffs.length) {
    return null;
  }

  const cyclePx = median(diffs);
  if (!Number.isFinite(cyclePx) || cyclePx <= 0) {
    return null;
  }

  return {
    metersPerPixel: dashCycleMeters / cyclePx,
    cyclePx,
    referenceY: median(centers),
    confidence: clamp(peaks.length / 6, 0.2, 0.95),
    sampleCount: peaks.length,
  };
}

function lineXAt(line, y) {
  return line.slope * y + line.intercept;
}

function toSourcePoint(frame, point) {
  return [point[0] / frame.scaleX, point[1] / frame.scaleY];
}

function chooseLanePair(lines, referenceY, frame, targetBox = null) {
  if (lines.length < 2) {
    return null;
  }
  const targetX = targetBox
    ? ((targetBox.x1 + targetBox.x2) / 2) * frame.scaleX
    : frame.width / 2;
  const positions = lines
    .map((line) => ({
      line,
      x: lineXAt(line, referenceY),
      support: line.support,
    }))
    .filter((item) => Number.isFinite(item.x))
    .sort((left, right) => left.x - right.x);

  const pairs = [];
  for (let index = 1; index < positions.length; index += 1) {
    const gap = positions[index].x - positions[index - 1].x;
    if (gap > 14 && gap < 280) {
      const centerX = (positions[index].x + positions[index - 1].x) / 2;
      const containsTarget = targetX >= positions[index - 1].x && targetX <= positions[index].x;
      pairs.push({
        leftLine: positions[index - 1].line,
        rightLine: positions[index].line,
        laneSpacingPx: gap,
        referenceY,
        confidence: clamp((positions[index - 1].support + positions[index].support) / 12, 0.2, 0.95),
        score:
          (containsTarget ? 1000 : 0) +
          positions[index - 1].support +
          positions[index].support -
          Math.abs(centerX - targetX) / 20,
      });
    }
  }

  if (!pairs.length) {
    return null;
  }

  return pairs.sort((left, right) => right.score - left.score)[0];
}

function buildRoadHomography(frame, lanePair, dashScale, laneWidthMeters, dashCycleMeters, vanishingPoint) {
  if (!lanePair || !dashScale?.cyclePx) {
    return null;
  }

  const cyclePx = dashScale.cyclePx;
  const minTop = Math.min(frame.height - 34, Math.max(0, vanishingPoint.y + 24));
  const maxTop = frame.height - 24;
  const referenceY = lanePair.referenceY || dashScale.referenceY;
  const yTop = clamp(
    referenceY - cyclePx / 2,
    minTop,
    maxTop,
  );
  const yBottom = clamp(
    yTop + cyclePx,
    yTop + Math.max(10, cyclePx * 0.35),
    frame.height - 6,
  );
  const lengthMeters = dashCycleMeters * ((yBottom - yTop) / cyclePx);
  if (!Number.isFinite(lengthMeters) || lengthMeters <= 0.5) {
    return null;
  }

  const imagePoints = [
    toSourcePoint(frame, [lineXAt(lanePair.leftLine, yTop), yTop]),
    toSourcePoint(frame, [lineXAt(lanePair.rightLine, yTop), yTop]),
    toSourcePoint(frame, [lineXAt(lanePair.rightLine, yBottom), yBottom]),
    toSourcePoint(frame, [lineXAt(lanePair.leftLine, yBottom), yBottom]),
  ];

  if (imagePoints.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return null;
  }

  try {
    return {
      homography: computeHomography(imagePoints, laneWidthMeters, lengthMeters),
      imagePoints,
      lengthMeters,
      yTop,
      yBottom,
    };
  } catch {
    return null;
  }
}

function estimatePcaAxis(points) {
  if (points.length < 2) {
    return null;
  }

  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const center = [
    points.reduce((sum, point) => sum + point.x * point.weight, 0) / totalWeight,
    points.reduce((sum, point) => sum + point.y * point.weight, 0) / totalWeight,
  ];

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - center[0];
    const dy = point.y - center[1];
    xx += point.weight * dx * dx;
    xy += point.weight * dx * dy;
    yy += point.weight * dy * dy;
  }

  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const eigenTerm = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda = trace / 2 + eigenTerm;
  const axis = normalize([lambda - yy, xy]) || normalize([xy, lambda - xx]) || [0, 1];
  const angleDeg = (Math.atan2(axis[1], axis[0]) * 180) / Math.PI;
  return {
    center,
    axis,
    angleDeg,
    confidence: clamp(points.length / 12, 0.1, 0.65),
    method: "pca",
  };
}

function summarizeCalibration(base) {
  const scaleX = base.scaleX || 1;
  const scaleY = base.scaleY || 1;
  const referenceY = clamp(base.referenceY / scaleY, (base.vanishingPoint.y / scaleY) + 24, base.sourceHeight - 20);
  const roadAxis = normalize([
    (base.roadAxis?.[0] || 0) * (scaleY / scaleX),
    base.roadAxis?.[1] || 1,
  ]) || [0, 1];
  const axisAngleDeg = (Math.atan2(roadAxis[1], roadAxis[0]) * 180) / Math.PI;
  const scaleAtY = (y) => {
    if (!Number.isFinite(base.referenceScaleMPerPx) || base.referenceScaleMPerPx <= 0) {
      return null;
    }
    const vpY = base.vanishingPoint.y / scaleY;
    const denominator = Math.max(24, y - vpY);
    const numerator = Math.max(24, referenceY - vpY);
    return base.referenceScaleMPerPx * (numerator / denominator);
  };
  const homography = base.homography || null;
  const projectPoint = homography
    ? (point) => {
        try {
          return projectHomographyPoint(homography, point);
        } catch {
          return null;
        }
    }
    : () => null;

  return {
    method: base.method,
    confidence: clamp(base.confidence, 0, 1),
    axis: roadAxis,
    angleDeg: axisAngleDeg,
    vanishingPoint: {
      x: base.vanishingPoint.x / scaleX,
      y: base.vanishingPoint.y / scaleY,
    },
    referenceY,
    laneSpacingPx: base.laneSpacingPx ? base.laneSpacingPx / scaleX : null,
    referenceScaleMPerPx: base.referenceScaleMPerPx ? base.referenceScaleMPerPx * scaleX : null,
    laneWidthMeters: base.laneWidthMeters,
    dashCycleMeters: base.dashCycleMeters,
    dashCyclePx: base.dashCyclePx ? base.dashCyclePx / scaleY : null,
    homography,
    homographyPoints: base.homographyPoints || null,
    projectedLengthMeters: base.projectedLengthMeters || null,
    projectPoint,
    scaleAtY,
  };
}

export function estimateRoadCalibration(samples, options = {}) {
  const laneWidthMeters = options.laneWidthMeters || DEFAULT_LANE_WIDTH_M;
  const dashCycleMeters = options.dashCycleMeters || DEFAULT_DASH_CYCLE_M;
  const allPoints = [];
  const lineCandidates = [];
  const frameAnalyses = [];

  for (const sample of samples) {
    if (!sample?.frameCanvas) {
      continue;
    }
    const frame = sampleFrame(sample.frameCanvas, sample.detections || []);
    frameAnalyses.push(frame);
    allPoints.push(...frame.points);
    const lines = fitRoadLines(frame.points, frame.width, frame.height);
    if (lines.length) {
      lineCandidates.push({ frame, lines });
    }
  }

  if (!lineCandidates.length || allPoints.length < 2) {
    const fallback = estimatePcaAxis(allPoints);
    if (!fallback) {
      return {
        method: "fallback",
        confidence: 0,
        axis: [0, 1],
        angleDeg: 90,
        vanishingPoint: { x: 0, y: 0 },
        referenceY: 0,
        laneSpacingPx: null,
        referenceScaleMPerPx: null,
        laneWidthMeters,
        dashCycleMeters,
        sourceWidth: 1,
        sourceHeight: 1,
        scaleX: 1,
        scaleY: 1,
        projectPoint: () => null,
        scaleAtY: () => null,
      };
    }
    return summarizeCalibration({
      ...fallback,
      method: "fallback-pca",
      confidence: fallback.confidence,
      vanishingPoint: { x: fallback.center[0], y: fallback.center[1] },
      referenceY: fallback.center[1],
      laneSpacingPx: null,
      referenceScaleMPerPx: null,
      laneWidthMeters,
      dashCycleMeters,
      sourceWidth: fallback.center[0] ? fallback.center[0] * 2 : 1,
      sourceHeight: fallback.center[1] ? fallback.center[1] * 2 : 1,
      scaleX: 1,
      scaleY: 1,
    });
  }

  const bestFrame = lineCandidates
    .slice()
    .sort((left, right) => {
      const leftSupport = left.lines[0]?.support || 0;
      const rightSupport = right.lines[0]?.support || 0;
      return rightSupport - leftSupport;
    })[0];

  const lines = bestFrame.lines;
  const vanishingPoint = estimateVanishingPoint(lines, bestFrame.frame.width, bestFrame.frame.height);
  const roadAxisLine = lines[0];
  const roadAxis = roadAxisLine?.direction || [0, 1];
  const targetReferenceY = options.targetBox?.y2
    ? options.targetBox.y2 * bestFrame.frame.scaleY
    : null;
  const referenceY = clamp(
    options.referenceY || targetReferenceY || bestFrame.frame.height * 0.78,
    vanishingPoint.y + 28,
    bestFrame.frame.height - 20,
  );

  const laneSpacing = chooseLanePair(lines, referenceY, bestFrame.frame, options.targetBox || null);
  const dashScale = estimateDashScale(bestFrame.frame, roadAxisLine, vanishingPoint, dashCycleMeters);
  const roadPlane = buildRoadHomography(
    bestFrame.frame,
    laneSpacing,
    dashScale,
    laneWidthMeters,
    dashCycleMeters,
    vanishingPoint,
  );

  let referenceScaleMPerPx = null;
  let scaleConfidence = 0;
  let method = "lane-edge";
  const laneScaleMPerPx = laneSpacing?.laneSpacingPx ? laneWidthMeters / laneSpacing.laneSpacingPx : null;

  if (laneScaleMPerPx) {
    referenceScaleMPerPx = laneScaleMPerPx;
    scaleConfidence += laneSpacing.confidence;
  }

  if (dashScale?.metersPerPixel) {
    if (referenceScaleMPerPx && laneScaleMPerPx) {
      const ratio = dashScale.metersPerPixel / laneScaleMPerPx;
      if (ratio >= 0.55 && ratio <= 1.8) {
        referenceScaleMPerPx = (referenceScaleMPerPx * 0.7) + (dashScale.metersPerPixel * 0.3);
        scaleConfidence += dashScale.confidence * 0.5;
      }
    } else {
      referenceScaleMPerPx = dashScale.metersPerPixel;
      scaleConfidence += dashScale.confidence;
    }
  }

  if (!referenceScaleMPerPx) {
    const fallback = estimatePcaAxis(allPoints);
    if (fallback) {
      return summarizeCalibration({
        ...fallback,
        method: "fallback-pca",
        confidence: fallback.confidence,
        vanishingPoint,
        referenceY,
        laneSpacingPx: null,
        referenceScaleMPerPx: null,
        laneWidthMeters,
        dashCycleMeters,
        sourceWidth: bestFrame.frame.sourceWidth,
        sourceHeight: bestFrame.frame.sourceHeight,
        scaleX: bestFrame.frame.scaleX,
        scaleY: bestFrame.frame.scaleY,
      });
    }
  }

  if (laneSpacing && dashScale) {
    method = roadPlane ? "lane homography" : "lane-marking + road-edge";
  } else if (laneSpacing) {
    method = "lane-marking + road-edge";
  } else if (dashScale) {
    method = "lane-marking";
  }

  return summarizeCalibration({
    method,
    confidence: clamp(
      0.35 + (lines[0]?.support || 0) / 12 + scaleConfidence / 4 + vanishingPoint.confidence * 0.3,
      0.2,
      0.98,
    ),
    roadAxis,
    vanishingPoint,
    referenceY,
    laneSpacingPx: laneSpacing?.laneSpacingPx || null,
    referenceScaleMPerPx,
    laneWidthMeters,
    dashCycleMeters,
    dashCyclePx: dashScale?.cyclePx || null,
    homography: roadPlane?.homography || null,
    homographyPoints: roadPlane?.imagePoints || null,
    projectedLengthMeters: roadPlane?.lengthMeters || null,
    sourceWidth: bestFrame.frame.sourceWidth,
    sourceHeight: bestFrame.frame.sourceHeight,
    scaleX: bestFrame.frame.scaleX,
    scaleY: bestFrame.frame.scaleY,
  });
}

export function estimateRoadAxis(samples, options = {}) {
  return estimateRoadCalibration(samples, options);
}
