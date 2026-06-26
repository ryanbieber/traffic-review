function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

export function solveLinearSystem(matrix, vector) {
  const a = cloneMatrix(matrix);
  const b = vector.slice();
  const size = b.length;

  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    let maxValue = Math.abs(a[pivot][pivot]);
    for (let row = pivot + 1; row < size; row += 1) {
      const value = Math.abs(a[row][pivot]);
      if (value > maxValue) {
        maxValue = value;
        maxRow = row;
      }
    }

    if (maxValue < 1e-12) {
      throw new Error("Homography solve failed: points are degenerate.");
    }

    if (maxRow !== pivot) {
      [a[pivot], a[maxRow]] = [a[maxRow], a[pivot]];
      [b[pivot], b[maxRow]] = [b[maxRow], b[pivot]];
    }

    const pivotValue = a[pivot][pivot];
    for (let column = pivot; column < size; column += 1) {
      a[pivot][column] /= pivotValue;
    }
    b[pivot] /= pivotValue;

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = a[row][pivot];
      if (factor === 0) {
        continue;
      }
      for (let column = pivot; column < size; column += 1) {
        a[row][column] -= factor * a[pivot][column];
      }
      b[row] -= factor * b[pivot];
    }
  }

  return b;
}

export function computeHomography(imagePoints, realWidthM, realLengthM) {
  if (imagePoints.length !== 4) {
    throw new Error("Perspective calibration requires four image points.");
  }
  if (realWidthM <= 0 || realLengthM <= 0) {
    throw new Error("Road patch dimensions must be positive.");
  }

  const destination = [
    [0, 0],
    [realWidthM, 0],
    [realWidthM, realLengthM],
    [0, realLengthM],
  ];

  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = imagePoints[index];
    const [u, v] = destination[index];
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    vector.push(v);
  }

  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(matrix, vector);
  return [
    [h11, h12, h13],
    [h21, h22, h23],
    [h31, h32, 1],
  ];
}

export function projectPoint(homography, point) {
  const [x, y] = point;
  const w =
    homography[2][0] * x +
    homography[2][1] * y +
    homography[2][2];
  if (Math.abs(w) < 1e-12) {
    throw new Error("Homography projection failed: point projected to infinity.");
  }
  const px =
    homography[0][0] * x +
    homography[0][1] * y +
    homography[0][2];
  const py =
    homography[1][0] * x +
    homography[1][1] * y +
    homography[1][2];
  return [px / w, py / w];
}
