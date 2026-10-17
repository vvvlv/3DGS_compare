# 3DGS Compare

Side-by-side / 2×2 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) viewer for comparing trained models on the same scene.

Built with [Spark](https://github.com/sparkjsdev/spark) + [Three.js](https://threejs.org/). Drop in `.ply` exports, compare methods with a locked first-person camera across all panels.

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

## Controls

Click view to pointer-lock · WASD + Space/Ctrl move (camera-relative) · Q/E roll · mouse look · Shift boost · hold RMB for fine control · Tab to exit.

**Layout (custom):** single · side-by-side · 2×2 · 2×3.  
**Load .ply:** pick a file from disk; it appears in the method dropdowns and loads into the left panel (use the dropdowns to put it in other panels).  
**Settings:** look / move sliders (saved in `localStorage`).

## Adding your own models

### Quick: Load .ply from the toolbar

Use **Load .ply** to open any exported Gaussian PLY without editing the manifest. The file stays in memory for this session and is selectable in every panel.

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
