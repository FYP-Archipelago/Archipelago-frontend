/**
 * Symmetric eigendecomposition by cyclic Jacobi rotation.
 *
 * The Python side reaches for `numpy.linalg.svd`. In the browser we only ever
 * need the leading eigenvectors of a covariance matrix whose size is the genome
 * dimension — 10 on every run in the corpus — so a full SVD dependency would be
 * several hundred kilobytes to solve a 10×10 problem. Jacobi is exact for
 * symmetric matrices, is about thirty lines, and hands back the eigenvalues,
 * which *are* the explained-variance ratios once normalised.
 */

export interface Eigen {
  /** Eigenvalues, descending. */
  values: Float64Array;
  /** Column i is the eigenvector for values[i]; stored row-major, d × d. */
  vectors: Float64Array;
}

/**
 * @param matrix d × d, symmetric, row-major. Not modified.
 */
export function jacobiEigen(matrix: Float64Array, d: number, sweeps = 60): Eigen {
  const a = Float64Array.from(matrix);
  const v = new Float64Array(d * d);
  for (let i = 0; i < d; i += 1) v[i * d + i] = 1;

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    // Largest remaining off-diagonal magnitude; stop once it is negligible.
    let off = 0;
    for (let p = 0; p < d; p += 1) {
      for (let q = p + 1; q < d; q += 1) off += a[p * d + q]! * a[p * d + q]!;
    }
    if (off < 1e-22) break;

    for (let p = 0; p < d; p += 1) {
      for (let q = p + 1; q < d; q += 1) {
        const apq = a[p * d + q]!;
        if (Math.abs(apq) < 1e-18) continue;

        const app = a[p * d + p]!;
        const aqq = a[q * d + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < d; k += 1) {
          const akp = a[k * d + p]!;
          const akq = a[k * d + q]!;
          a[k * d + p] = c * akp - s * akq;
          a[k * d + q] = s * akp + c * akq;
        }
        for (let k = 0; k < d; k += 1) {
          const apk = a[p * d + k]!;
          const aqk = a[q * d + k]!;
          a[p * d + k] = c * apk - s * aqk;
          a[q * d + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < d; k += 1) {
          const vkp = v[k * d + p]!;
          const vkq = v[k * d + q]!;
          v[k * d + p] = c * vkp - s * vkq;
          v[k * d + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: d }, (_, i) => i).sort(
    (x, y) => a[y * d + y]! - a[x * d + x]!,
  );
  const values = new Float64Array(d);
  const vectors = new Float64Array(d * d);
  for (let rank = 0; rank < d; rank += 1) {
    const source = order[rank]!;
    values[rank] = a[source * d + source]!;
    for (let row = 0; row < d; row += 1) {
      vectors[row * d + rank] = v[row * d + source]!;
    }
  }
  return { values, vectors };
}
