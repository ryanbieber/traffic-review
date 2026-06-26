# Traffic Review

A web app for reviewing traffic-camera footage with YOLO-based vehicle detection, tracking, and speed estimation.

## What it does

- Serves a real frontend website from `docs/`.
- Accepts traffic-camera uploads through a FastAPI backend.
- Uses YOLO to detect and track vehicles.
- Estimates speed from tracked motion after perspective calibration.
- Exports an annotated review video and a CSV summary.

## Important limitation

GitHub Pages can only host the frontend. The YOLO, OpenCV, and video-processing pipeline still needs a backend server. This project is designed for review and sanity-checking, not certified enforcement.

## Architecture

- `docs/`: Static site for GitHub Pages.
- `src/traffic_review/api.py`: FastAPI backend.
- `src/traffic_review/analyzer.py`: YOLO tracking, speed estimation, and annotation.
- `src/traffic_review/calibration.py`: Homography and scale calibration helpers.

## Local run

```bash
cd /home/carnufex/traffic-review
uv sync
PYTHONPATH=src .venv/bin/uvicorn traffic_review.api:app --reload
```

Then open:

- `http://localhost:8000/site/` for the website
- `http://localhost:8000/api/health` for the API health check

## GitHub Pages

The included workflow at `.github/workflows/pages.yml` deploys the `docs/` folder to GitHub Pages when you push `main`.

To publish it:

1. Create a new GitHub repository named `traffic-review`.
2. Add it as the remote:

```bash
git -C /home/carnufex/traffic-review remote add origin git@github.com:YOUR_USER/traffic-review.git
```

3. Commit and push:

```bash
git -C /home/carnufex/traffic-review add .
git -C /home/carnufex/traffic-review commit -m "Build web app version of traffic review"
git -C /home/carnufex/traffic-review branch -M main
git -C /home/carnufex/traffic-review push -u origin main
```

4. In GitHub repository settings, enable Pages with `GitHub Actions`.

## Backend hosting

You still need a backend host for the actual analysis. Reasonable choices are:

- Render
- Railway
- Fly.io
- A GPU-enabled VPS if you want faster runs

Once deployed, set the frontend's `API base URL` field to that backend origin.

## Recommended workflow

1. Use fixed-camera footage.
2. Default to the `4-point road plane` calibration.
3. Re-run with tighter points if the first estimate looks unstable.
4. Compare the annotated clip and the exported summary, not just one number.
