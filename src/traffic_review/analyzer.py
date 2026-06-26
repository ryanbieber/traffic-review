from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable

import cv2
import numpy as np
import pandas as pd
from ultralytics import YOLO

from traffic_review.calibration import PerspectiveCalibration, SimpleCalibration, meters_per_pixel_from_reference

VEHICLE_CLASS_IDS = [2, 3, 5, 7]
MPS_TO_MPH = 2.2369362920544
ProgressCallback = Callable[[float, str], None]


@dataclass(slots=True)
class AnalysisConfig:
    model_name: str = "yolov8n.pt"
    confidence_threshold: float = 0.35
    history_seconds: float = 0.75
    max_track_history: int = 20
    speed_limit_mph: float = 35.0
    fps_override: float | None = None
    calibration_mode: str = "reference"
    manual_meters_per_pixel: float = 0.04
    reference_point_a: tuple[int, int] = (100, 100)
    reference_point_b: tuple[int, int] = (300, 100)
    reference_distance_m: float = 3.7
    perspective_points: tuple[tuple[int, int], ...] = (
        (200, 200),
        (500, 200),
        (650, 500),
        (50, 500),
    )
    perspective_width_m: float = 3.7
    perspective_length_m: float = 20.0


@dataclass(slots=True)
class VehicleSummary:
    track_id: int
    label: str
    peak_speed_mph: float
    avg_speed_mph: float
    frames_seen: int
    first_seen_s: float
    last_seen_s: float
    flagged: bool


@dataclass(slots=True)
class AnalysisResult:
    annotated_video_path: Path
    summary: pd.DataFrame
    calibration_description: str
    note: str


def analyze_video(
    input_video: Path,
    config: AnalysisConfig,
    progress_callback: ProgressCallback | None = None,
) -> AnalysisResult:
    with TemporaryDirectory(prefix="traffic-review-") as temp_dir:
        temp_dir_path = Path(temp_dir)
        output_video = temp_dir_path / "annotated.mp4"

        capture = cv2.VideoCapture(str(input_video))
        if not capture.isOpened():
            raise ValueError(f"Unable to open video: {input_video}")

        fps = config.fps_override or capture.get(cv2.CAP_PROP_FPS) or 0.0
        if fps <= 0:
            fps = 30.0
        frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
        frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        capture.release()

        calibration, calibration_description = _build_calibration(config)
        note = _build_note(config)

        writer = cv2.VideoWriter(
            str(output_video),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (frame_width, frame_height),
        )
        if not writer.isOpened():
            raise ValueError("Unable to create annotated output video.")

        model = YOLO(config.model_name)
        histories: dict[int, deque[tuple[int, np.ndarray]]] = {}
        speed_samples: dict[int, list[float]] = {}
        metadata: dict[int, dict[str, float | str | int]] = {}

        stream = model.track(
            source=str(input_video),
            stream=True,
            persist=True,
            verbose=False,
            conf=config.confidence_threshold,
            classes=VEHICLE_CLASS_IDS,
            tracker="bytetrack.yaml",
        )

        for frame_index, result in enumerate(stream):
            frame = result.orig_img.copy()
            boxes = result.boxes
            if boxes is not None and boxes.id is not None:
                ids = boxes.id.int().cpu().tolist()
                xyxy = boxes.xyxy.cpu().tolist()
                classes = boxes.cls.int().cpu().tolist()
                for track_id, coords, class_id in zip(ids, xyxy, classes, strict=False):
                    x1, y1, x2, y2 = coords
                    anchor = ((x1 + x2) / 2.0, y2)
                    world_point = calibration.project_point(anchor)
                    history = histories.setdefault(track_id, deque(maxlen=config.max_track_history))
                    history.append((frame_index, world_point))
                    current_speed = _estimate_speed(history, fps, config.history_seconds)
                    samples = speed_samples.setdefault(track_id, [])
                    if current_speed is not None:
                        samples.append(current_speed)

                    label = result.names.get(class_id, str(class_id))
                    first_seen = metadata.setdefault(
                        track_id,
                        {
                            "label": label,
                            "first_seen_s": frame_index / fps,
                        },
                    )
                    first_seen["last_seen_s"] = frame_index / fps
                    first_seen["frames_seen"] = int(first_seen.get("frames_seen", 0)) + 1

                    peak_speed = max(speed_samples.get(track_id, [0.0])) if speed_samples.get(track_id) else 0.0
                    flagged = peak_speed >= config.speed_limit_mph
                    _draw_box(frame, coords, label, track_id, current_speed, flagged)

            _draw_header(frame, frame_index, fps, calibration_description, config.speed_limit_mph)
            writer.write(frame)
            if progress_callback and frame_count > 0:
                progress_callback(min((frame_index + 1) / frame_count, 1.0), f"Processed {frame_index + 1}/{frame_count} frames")

        writer.release()
        summary = _build_summary(metadata, speed_samples, config.speed_limit_mph)
        final_output = input_video.with_name(f"{input_video.stem}-annotated.mp4")
        final_output.write_bytes(output_video.read_bytes())
        return AnalysisResult(
            annotated_video_path=final_output,
            summary=summary,
            calibration_description=calibration_description,
            note=note,
        )


def _build_calibration(config: AnalysisConfig) -> tuple[SimpleCalibration | PerspectiveCalibration, str]:
    if config.calibration_mode == "manual":
        if config.manual_meters_per_pixel <= 0:
            raise ValueError("Manual meters-per-pixel must be positive.")
        return SimpleCalibration(config.manual_meters_per_pixel), (
            f"Manual scale: {config.manual_meters_per_pixel:.5f} meters/pixel"
        )

    if config.calibration_mode == "perspective":
        calibration = PerspectiveCalibration.from_points(
            config.perspective_points,
            real_width_m=config.perspective_width_m,
            real_length_m=config.perspective_length_m,
        )
        description = (
            "Perspective plane: "
            f"{config.perspective_width_m:.2f}m x {config.perspective_length_m:.2f}m road patch"
        )
        return calibration, description

    meters_per_pixel = meters_per_pixel_from_reference(
        config.reference_point_a,
        config.reference_point_b,
        config.reference_distance_m,
    )
    description = (
        f"Reference scale: {config.reference_distance_m:.2f}m across points "
        f"{config.reference_point_a} -> {config.reference_point_b}"
    )
    return SimpleCalibration(meters_per_pixel), description


def _build_note(config: AnalysisConfig) -> str:
    if config.calibration_mode == "perspective":
        return (
            "Speeds are estimated from tracked vehicle motion projected onto a calibrated road plane. "
            "This is stronger than raw pixel scaling, but it still depends on accurate point selection and camera stability."
        )
    return (
        "Speeds are estimated from YOLO tracking plus a single image scale. "
        "Treat them as review evidence, not survey-grade measurement, unless you have strong calibration data."
    )


def _estimate_speed(
    history: deque[tuple[int, np.ndarray]],
    fps: float,
    history_seconds: float,
) -> float | None:
    if len(history) < 2:
        return None
    newest_frame, newest_point = history[-1]
    threshold_frames = max(1, int(history_seconds * fps))
    oldest_index = 0
    for index in range(len(history) - 2, -1, -1):
        candidate_frame, _candidate_point = history[index]
        if newest_frame - candidate_frame >= threshold_frames:
            oldest_index = index
            break
    oldest_frame, oldest_point = history[oldest_index]
    elapsed_frames = newest_frame - oldest_frame
    if elapsed_frames <= 0:
        return None
    elapsed_seconds = elapsed_frames / fps
    distance_m = float(np.linalg.norm(newest_point - oldest_point))
    meters_per_second = distance_m / elapsed_seconds
    return meters_per_second * MPS_TO_MPH


def _build_summary(
    metadata: dict[int, dict[str, float | str | int]],
    speed_samples: dict[int, list[float]],
    speed_limit_mph: float,
) -> pd.DataFrame:
    rows: list[VehicleSummary] = []
    for track_id, details in metadata.items():
        samples = speed_samples.get(track_id, [])
        peak_speed = max(samples) if samples else 0.0
        avg_speed = float(np.mean(samples)) if samples else 0.0
        rows.append(
            VehicleSummary(
                track_id=track_id,
                label=str(details.get("label", "vehicle")),
                peak_speed_mph=peak_speed,
                avg_speed_mph=avg_speed,
                frames_seen=int(details.get("frames_seen", 0)),
                first_seen_s=float(details.get("first_seen_s", 0.0)),
                last_seen_s=float(details.get("last_seen_s", 0.0)),
                flagged=peak_speed >= speed_limit_mph,
            )
        )

    dataframe = pd.DataFrame([row.__dict__ for row in rows])
    if not dataframe.empty:
        dataframe = dataframe.sort_values(by="peak_speed_mph", ascending=False).reset_index(drop=True)
    return dataframe


def _draw_box(
    frame: np.ndarray,
    coords: list[float],
    label: str,
    track_id: int,
    speed_mph: float | None,
    flagged: bool,
) -> None:
    x1, y1, x2, y2 = map(int, coords)
    color = (0, 0, 255) if flagged else (40, 180, 99)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    speed_text = "speed n/a" if speed_mph is None else f"{speed_mph:5.1f} mph"
    text = f"#{track_id} {label} {speed_text}"
    cv2.putText(frame, text, (x1, max(24, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)


def _draw_header(frame: np.ndarray, frame_index: int, fps: float, calibration_description: str, speed_limit_mph: float) -> None:
    timestamp = frame_index / fps
    header_lines = [
        f"Traffic Review  |  t={timestamp:0.2f}s  |  Speed limit {speed_limit_mph:.1f} mph",
        calibration_description,
    ]
    for row_index, text in enumerate(header_lines):
        cv2.putText(
            frame,
            text,
            (20, 30 + row_index * 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
