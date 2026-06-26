# Traffic Review

A GitHub Pages-compatible web app for reviewing traffic-camera footage with browser-side YOLO detection, tracking, homography, and speed estimation.

## What it does

- Runs entirely in the browser from the static `docs/` site.
- Accepts a local traffic-camera video file without uploading it to a server.
- Loads a YOLOv8 ONNX model directly in the browser through ONNX Runtime Web.
- Uses a 4-point perspective calibration to correct for angled camera views.
- Tracks detected vehicles and estimates speed from projected road-plane motion.
- Exports a summary CSV, JSON analysis record, and an annotated WebM review clip.

## Important limitation

This is still review tooling, not certified enforcement measurement. The estimates depend on your road-plane calibration, the visible quality of the clip, and the performance of the user’s browser.

## Architecture

- `docs/`: the deployable GitHub Pages app.
- `docs/app.js`: browser workflow, replay, and export logic.
- `docs/lib/yolo.js`: ONNX Runtime Web inference and YOLO postprocessing.
- `docs/lib/homography.js`: client-side homography solve and point projection.
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

The smoke test serves `docs/`, generates a small in-browser WebM clip from a real bus image, runs the full browser-only analysis path in headless Chrome, and verifies that the app produces a result row and downloadable CSV.

## Recommended workflow for real clips

1. Use fixed-camera footage.
2. Keep clips short enough that in-browser processing is realistic.
3. Mark four corners of a flat road patch in clockwise order.
4. Re-run with tighter points if the first estimate looks unstable.
5. Compare the annotated replay and exported summary, not just one number.
