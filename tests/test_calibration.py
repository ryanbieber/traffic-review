import numpy as np

from traffic_review.analyzer import _estimate_speed
from traffic_review.calibration import PerspectiveCalibration, meters_per_pixel_from_reference


def test_reference_distance_to_scale() -> None:
    scale = meters_per_pixel_from_reference((0, 0), (100, 0), 10.0)
    assert scale == 0.1


def test_perspective_projection_identity_rectangle() -> None:
    calibration = PerspectiveCalibration.from_points(
        [(0, 0), (200, 0), (200, 400), (0, 400)],
        real_width_m=2.0,
        real_length_m=4.0,
    )
    point = calibration.project_point((100, 200))
    np.testing.assert_allclose(point, np.array([1.0, 2.0]), atol=1e-3)


def test_speed_estimate_uses_world_distance() -> None:
    history = [
        (0, np.array([0.0, 0.0])),
        (15, np.array([0.0, 5.0])),
    ]
    speed = _estimate_speed(history, fps=30.0, history_seconds=0.4)
    assert speed is not None
    assert round(speed, 2) == 22.37
