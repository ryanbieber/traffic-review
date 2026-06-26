from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import cv2
import numpy as np


@dataclass(slots=True)
class SimpleCalibration:
    meters_per_pixel: float

    def project_point(self, point: tuple[float, float]) -> np.ndarray:
        return np.asarray(point, dtype=np.float32)


@dataclass(slots=True)
class PerspectiveCalibration:
    homography: np.ndarray
    output_size_meters: tuple[float, float]
    output_size_pixels: tuple[int, int]

    @classmethod
    def from_points(
        cls,
        image_points: Iterable[tuple[float, float]],
        real_width_m: float,
        real_length_m: float,
        scale: int = 100,
    ) -> "PerspectiveCalibration":
        image_points_array = np.asarray(list(image_points), dtype=np.float32)
        if image_points_array.shape != (4, 2):
            raise ValueError("Perspective calibration requires exactly four image points.")
        if real_width_m <= 0 or real_length_m <= 0:
            raise ValueError("Real-world dimensions must be positive.")

        width_px = max(1, int(real_width_m * scale))
        length_px = max(1, int(real_length_m * scale))
        destination = np.asarray(
            [
                [0, 0],
                [width_px, 0],
                [width_px, length_px],
                [0, length_px],
            ],
            dtype=np.float32,
        )
        homography = cv2.getPerspectiveTransform(image_points_array, destination)
        return cls(
            homography=homography,
            output_size_meters=(real_width_m, real_length_m),
            output_size_pixels=(width_px, length_px),
        )

    def project_point(self, point: tuple[float, float]) -> np.ndarray:
        point_array = np.asarray([[point]], dtype=np.float32)
        projected = cv2.perspectiveTransform(point_array, self.homography)
        return projected[0, 0] / 100.0


def meters_per_pixel_from_reference(
    point_a: tuple[float, float],
    point_b: tuple[float, float],
    real_distance_m: float,
) -> float:
    if real_distance_m <= 0:
        raise ValueError("Reference distance must be positive.")
    pixel_distance = float(np.linalg.norm(np.asarray(point_a) - np.asarray(point_b)))
    if pixel_distance <= 0:
        raise ValueError("Reference points must be different.")
    return real_distance_m / pixel_distance
