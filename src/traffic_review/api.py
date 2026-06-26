from __future__ import annotations

import json
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from traffic_review.analyzer import AnalysisConfig, analyze_video

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"
OUTPUTS_DIR = ROOT / "outputs"
OUTPUTS_DIR.mkdir(exist_ok=True)

app = FastAPI(
    title="Traffic Review API",
    description="YOLO-backed traffic-camera review service",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if DOCS_DIR.exists():
    app.mount("/site", StaticFiles(directory=DOCS_DIR, html=True), name="site")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/analyze")
async def analyze(
    video: UploadFile = File(...),
    config: str = Form(...),
) -> dict[str, object]:
    run_id = uuid4().hex[:12]
    run_dir = OUTPUTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    try:
        parsed = json.loads(config)
        analysis_config = AnalysisConfig(**parsed)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid config payload: {exc}") from exc

    suffix = Path(video.filename or "upload.mp4").suffix or ".mp4"
    input_path = run_dir / f"input{suffix}"
    with input_path.open("wb") as handle:
        shutil.copyfileobj(video.file, handle)

    try:
        result = analyze_video(input_path, analysis_config)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    summary_path = run_dir / "summary.csv"
    result.summary.to_csv(summary_path, index=False)

    annotated_path = run_dir / "annotated.mp4"
    shutil.copy2(result.annotated_video_path, annotated_path)

    return {
        "run_id": run_id,
        "calibration_description": result.calibration_description,
        "note": result.note,
        "summary": result.summary.to_dict(orient="records"),
        "downloads": {
            "video": f"/api/results/{run_id}/video",
            "summary_csv": f"/api/results/{run_id}/summary.csv",
        },
    }


@app.get("/api/results/{run_id}/video")
def download_video(run_id: str) -> FileResponse:
    path = OUTPUTS_DIR / run_id / "annotated.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Result video not found")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/api/results/{run_id}/summary.csv")
def download_summary(run_id: str) -> FileResponse:
    path = OUTPUTS_DIR / run_id / "summary.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Result summary not found")
    return FileResponse(path, media_type="text/csv", filename=path.name)
