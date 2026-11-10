# 3DGS Compare

Side-by-side / 2×2 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) viewer for comparing trained models on the same scene.

Built with [Spark](https://github.com/sparkjsdev/spark) + [Three.js](https://threejs.org/). Compare methods with a locked first-person camera across all panels — from the manifest, or by loading a `.ply` straight from disk.

## Quick start

```bash
git clone https://github.com/vvvlv/3DGS_compare.git
cd 3DGS_compare
./serve.sh
# open http://127.0.0.1:8765/
```

Requires a modern browser with WebGL2. No build step — static HTML/JS served over HTTP.

Optional: `PORT=8080 HOST=0.0.0.0 ./serve.sh`

## Modes

| Mode | Behavior |
|---|---|
| **Experiment** | Pick an experiment (e.g. `fair5`); all of its models load and layout auto-picks (1 / 2 / ≤4 / ≤6 → single / dual / 2×2 / 2×3). |
| **Custom** | Manually choose layout and which model goes in each panel. |

Experiments are grouped from each method’s `experiment` field (or a `[tag]` label prefix). Optional manifest keys: `default_viewer_mode`, `default_experiment`, `experiments: [{ id, label, methods }]`.

## Training Explorer

The compare grid stays the main surface. **Training Explorer** opens an in-page side panel (metrics + training curves) and a bottom scrubber. It does **not** open a second browser window, and toggling it does not reload the experiment.

| Control | Behavior |
|---|---|
| **Training Explorer** (toolbar) | Toggle the side panel + scrubber. |
| **Bottom slider** | Steps through that experiment’s capture iterations (e.g. 50 / 150 / 300 / 500). `[` / `]` also step when not flying. |
| **Interactive** | Load each panel’s checkpoint `.ply` for the selected step (Spark splat view). |
| **Rendered** | Show fixed-POV preview images for the selected step instead of the live splat. |
| **Camera** | Which fixed POV to show in Rendered mode (`00000` …). Each method/step can have several renders. |

Side panel contents (from `viewer/reports/<experiment>.json` when published):

- **Pipeline** live status (see below)
- Protocol / campaign summary
- Evaluation table (PSNR, SSIM, LPIPS, Gaussians, VRAM, create time)
- Curves: checkpoint evaluation (PSNR / SSIM / LPIPS vs capture iteration from `preview_series`; click a point to scrub) and training traces (loss / Gaussians / VRAM vs step from `trace`)

Pipeline publish should fill `checkpoint_urls` (mid-run PLYs) and `preview_urls` (fixed-POV PNGs under `viewer/previews/`). Optional `gt/` siblings support ground-truth references when present.

### Live launch status

While `launch.py` is running, it atomically writes `viewer/live.json` (gitignored). The Training Explorer polls that file about every 3s and shows:

- Experiment label and overall status (`running` / `done` / `failed`, or `stale` if updates stop for ~3 minutes)
- Per-method chips: `queued` → `running` → `done` / `failed` / `oom`

**Queued** means methods still waiting in the **active** launch (sequential). There is no multi-experiment job queue — a second `launch.py` overwrites `live.json`.

The experiment dropdown also badges the matching experiment, e.g. `(running 2/6)`.

Start a smoke from the pipeline root:

```bash
cd project/pipeline
python3 launch.py truck_smoke_200
# optional: python3 launch.py truck_smoke_200 2>&1 | tee results/logs/truck_smoke_200.out
```

Then open the viewer (`./serve.sh`), switch to **Experiment** mode, and open **Training Explorer** → **Pipeline**.

Capture notes (pipeline):

- Nerfstudio mid-run previews use staged checkpoints + `ns-eval` (Nerfstudio cameras). Do **not** render exported NS PLYs with raw COLMAP/GraphDECO cameras — the frames do not match.
- With `save_ply: false`, mid PLYs are not kept; only preview PNGs (and the final `splat.ply`) remain. Capture runs after each method’s train finishes.
- Official mid-run PLYs with incomplete SH bands are zero-padded before `render.py` (Mini-Splatting). Diet’s DataLoader camera wrapper is unwrapped in `render.py`; if a method’s own renderer still fails, the launcher falls back to a shared GraphDECO preview path.
- Training Explorer charts show labeled X/Y axes (step vs metric).

### Dummy experiment

A synthetic fixture ships for UI testing without a GPU run:

- Report: [`reports/dummy_training.json`](reports/dummy_training.json)
- Previews: `previews/dummy_training_method_{a,b}/iter_*/{renders,gt}/`
- Checkpoints: reuses the two demo Truck PLYs so Interactive mode visibly swaps models

Select **Experiment → Dummy — Training Explorer**, open **Training Explorer**, scrub the slider, and switch Interactive / Rendered / Camera.

## Controls

Click view to pointer-lock · WASD + Space/Ctrl move (camera-relative) · Q/E roll · mouse look · Shift boost · hold RMB for fine control · Tab to exit.

**Layout (custom):** single · side-by-side · 2×2 · 2×3.  
**Load .ply:** open a Gaussian PLY from disk (see below).  
**Settings:** look / move sliders (saved in `localStorage`).  
**Training Explorer:** side panel + capture scrubber (see above).

## Adding your own models

### Load .ply from disk

Click **Load .ply** in the toolbar and choose a file. No manifest edit or `splats/` copy needed.

- Opens the system file picker and loads into the **left** panel (camera resets to that model).
- The file is added to every panel’s method dropdown for this browser session (in-memory only; reload clears it).
- Assign it to other panels via those dropdowns.
- If you were in Experiment mode, the viewer switches to Custom so the new entry stays selectable.

Works with standard 3DGS / Nerfstudio / Mini-Splatting PLY exports. Orientation uses the same ground-plane heuristic as manifest models (no `up_axis` / `dataparser` metadata for ad-hoc files).

### Via manifest

1. Put Nerfstudio / 3DGS / Mini-Splatting `.ply` exports in `splats/`
2. Edit `manifest.json`:

```json
{
  "default_left": "my_a",
  "default_tc": "my_e",
  "default_right": "my_b",
  "default_bl": "my_c",
  "default_bc": "my_f",
  "default_br": "my_d",
  "methods": [
    {
      "id": "my_a",
      "label": "Method A",
      "url": "splats/a.ply",
      "num_gaussians": 150000,
      "psnr": 24.1,
      "ssim": 0.85,
      "lpips": 0.12,
      "peak_vram_mib": 4800,
      "notes": "optional caption"
    }
  ]
}
```

Metrics fields may be `null`. On load, each PLY is oriented (manifest `up_axis` or ground-plane heuristic). Same-convention exports (e.g. all OpenCV) share TL/left’s COLMAP frame; Nerfstudio Z-up is fit to the same view size on its own bounds. One WebGL canvas + camera keeps the viewpoint identical.

Reload the page after editing the manifest.

### Local overlay (optional)

For machine-local / pipeline results without dirtying git, add `manifest.local.json`
(gitignored). By default it merges on top of `manifest.json`; set `"replace_methods": true`
to show only the local list (hides public demos). The training pipeline writes this file
and symlinks `splats/bench_*.ply` / `splats/fair5_*.ply`.

## Demo assets

This repo ships two Truck (Tanks and Temples) demo PLYs under `splats/` so the viewer works out of the box:

| ID | Description |
|---|---|
| `mcmc_150k` | Splatfacto MCMC with a 150k Gaussian cap |
| `mini_splat_500k` | Mini-Splatfacto (gsplat / Nerfstudio port) |

Larger exports are intentionally not committed (GitHub file size limits). Add your own under `splats/`.

## Stack

- [Spark](https://github.com/sparkjsdev/spark) (`@sparkjsdev/spark` CDN) — Gaussian splat renderer for Three.js
- Three.js 0.180 (CDN)
- Plain `manifest.json` + static file server

## License

MIT — see [LICENSE](LICENSE).

Demo scene data originates from the [Tanks and Temples](https://www.tanksandtemples.org/) *Truck* split; method implementations belong to their respective authors (3DGS, Nerfstudio / gsplat, Mini-Splatting).
