# Traffic Review

A GitHub Pages-compatible web app for reviewing traffic-camera footage with browser-side YOLO detection, tracking, and rough speed estimation.

## What it does

- Runs entirely in the browser from the static `docs/` site.
- Accepts a local traffic-camera video file without uploading it to a server.
- Loads a YOLOv8 ONNX model directly in the browser through ONNX Runtime Web.
- Scans the clip automatically after a file is dropped or selected.
- Lets you click the specific vehicle you want to track when multiple vehicles are visible.
- Tracks only that selected vehicle and produces rough speed estimates from screen motion plus assumed vehicle width.
- Exports a summary CSV, JSON analysis record, and an annotated WebM review clip.

## Important limitation

This is still review tooling, not certified enforcement measurement. The current simple mode does not use explicit scene calibration, so the speed values are rough estimates rather than defensible true road speed.

## Architecture

- `docs/`: the deployable GitHub Pages app.
- `docs/app.js`: browser workflow, replay, and export logic.
- `docs/lib/yolo.js`: ONNX Runtime Web inference and YOLO postprocessing.
- `docs/lib/tracker.js`: lightweight vehicle tracking and speed estimation.
- `docs/assets/models/yolov8n.onnx`: browser-loaded YOLO model.

## Local run

```bash
cd /home/carnufex/traffic-review
python3 -m http.server 4173 --directory docs
```

Then open `http://127.0.0.1:4173/`.

## Browser-only behavior

- The uploaded file stays local to the browser session.
- The app seeks through the video in sampled intervals, so shorter clips are much more practical.
- WebGPU is attempted first where available, then the app falls back to WASM.
- On weaker machines, longer clips will run slowly or hit memory limits.
- Some MP4 files still fail if the browser cannot decode the video codec inside the container.

## GitHub Pages

The included workflow at `.github/workflows/pages.yml` deploys the `docs/` folder to GitHub Pages when you push `main`.

This repo is already set up for that model. No backend deployment is required.

## Validation

- Unit tests:

```bash
cd /home/carnufex/traffic-review
npm run test:unit
```

- Browser smoke test:

```bash
cd /home/carnufex/traffic-review
npm run test:browser
```

The smoke test serves `docs/`, generates a small in-browser WebM clip from a real bus image, waits for the selection prompt, clicks a detected vehicle on the canvas, and verifies that the app produces target-specific results and downloadable output.

## Recommended workflow for real clips

1. Use fixed-camera footage.
2. Keep clips short enough that in-browser processing is realistic.
3. Click the specific vehicle you want to track if multiple vehicles are present.
4. Treat the reported speeds as rough estimates, not survey-grade measurements.
5. Compare the annotated replay and exported summary, not just one number.
