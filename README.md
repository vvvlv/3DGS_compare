# 3DGS Compare

Side-by-side [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) viewer for comparing trained models on the same scene.

Built with [Spark](https://github.com/sparkjsdev/spark) + [Three.js](https://threejs.org/). Drop in `.ply` exports, pick two methods, and fly or orbit with a locked camera across both panels.

## Quick start

```bash
git clone https://github.com/vvvlv/3DGS_compare.git
cd 3DGS_compare
./serve.sh
# open http://127.0.0.1:8765/
```

Requires a modern browser with WebGL2. No build step — static HTML/JS served over HTTP.

Optional: `PORT=8080 HOST=0.0.0.0 ./serve.sh`

## Controls

| Control mode | Input |
|---|---|
| **First person** | Click view to pointer-lock · WASD + Space/Ctrl move (camera-relative) · Q/E roll · mouse look · Shift boost · hold RMB for fine control · Tab to exit |
| **Orbit (antimatter)** | LMB orbit · RMB pan · wheel orbit · Ctrl+wheel dolly · Shift+wheel pan · WASD/QE rotate |

**Layout:** single panel or side-by-side (shared camera).  
**Settings:** look / move / orbit sliders (saved in `localStorage`).

## Adding your own models

1. Put Nerfstudio / 3DGS / Mini-Splatting `.ply` exports in `splats/`
2. Edit `manifest.json`:

```json
{
  "default_left": "my_a",
  "default_right": "my_b",
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

Metrics fields may be `null`. On load, each model is auto-aligned into a shared robust frame (Y-up, percentile-trimmed center/scale) so side-by-side comparison stays readable even when floaters differ.

Reload the page after editing the manifest.

### Local overlay (optional)

For machine-local / pipeline results without dirtying git, add `manifest.local.json`
(gitignored). The viewer merges it on top of `manifest.json`. The training pipeline
writes this file automatically and symlinks `splats/bench_*.ply`.

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
