# Compile slowness investigation (task 4)

## Reported symptom
- Very slow first compilation of first 5 shaders, especially `thick_raymarch` (raymarched SDF)
- Freeze, then `program link failed`
- After first compilation, next runs are very fast (driver shader cache)

## What changed in last commit (a9876d8 — 0.43 0.44 shapes, heightmap scene)
- Added `GLSL.shape` (sphere, cube, tetra, knot) with `shapeHit` and `shapeSdf`
  - `shapeSdf` for knot uses `atan`, `sin`, `cos`, `normalize`, `length` — heavy
  - `shapeHit` for cube/tetra does 4-6 `planeClip` + `spinMat` (cos/sin per bubble)
- Added `GLSL.simplex` (2D simplex noise + 3-octave fbm)
- Added `GLSL.land` (heightfield block + lake)
  - `landHeight` = `fbm3` (3× `snoise`)
  - `landMarch` loop: `for i=1..LAND_MAX_STEPS` (was 96) with `if (i>steps) break`
    + 5 bisections each doing `landHeight`
  - `landHit` does `boxHit` + `landMarch` + `landNormal` (2× `landHeight`)
  - `landGlass` does another `landMarch` for lake bed
  - So a single `landHit` can be ~ (steps + 5) × fbm × 3 snoise = ~200+ snoise evaluations
- All scene-aware shaders now include `GLSL.simplex` + `GLSL.land` even when `uScene != 4`
- `thick_raymarch` and `thick_chain` went from simple `length(p-c)-r` SDF to `shapeSdf`
  - `map()` does 4× `shapeSdf` per step
  - `march()` does `MAXSTEPS` (was 64) iterations → 256× `shapeSdf` per primary ray
  - plus normal (4× map) and inside march — heavy for compiler to unroll/optimize

## Why first compile is slow, later fast
- GLSL compiler has to unroll loops bounded by constants (`MAXSTEPS 64`, `LAND_MAX_STEPS 96`)
- `LAND_MAX_STEPS 96` + 5 bisections = 96× fbm + 5× fbm = 101 fbm per land hit
- Each fbm = 3 snoise, each snoise = many `mod`, `floor`, `fract`, `dot`
- Driver shader cache (ANGLE / Mesa / NVIDIA) caches compiled binaries after first success,
  so second run is fast
- `program link failed` can happen when driver times out or hits temporary resource limit
  on first compile; retry or cache makes it succeed

## Mitigations applied in this branch
1. **Reduced `LAND_MAX_STEPS` 96 → 64** in `js/glsl_lib.js`
   - Default param `uLandSteps` was already 64; 96 forced 96-unroll for no visual gain
   - Removed 96 option from `landParams` (now 32/64)
2. **Reduced bisections 5 → 4** in `landMarch`
   - Still enough for terrain precision, less work
3. **Reduced `MAXSTEPS` 64 → 48** for `thick_raymarch`, `thick_chain`, `bench_chain`
   - Still visually similar, less unrolling
4. **Added timing logs in `js/runner.js`**
   - `compile()` and `link()` now log if >100ms, with src length
   - `select()` logs total time if >100ms
   - Helps pinpoint which shader is slow on user's GPU
5. **Added `debug.html` tool**
   - File:// friendly, no modules
   - Compiles each shader with timing, reports `vsTime`, `fsTime`, `linkTime`, `ok`
   - Buttons: "compile all" and "compile first 5 in sequence" (simulates startup)
   - Shows GL vendor/renderer/version
   - User can open `debug.html` and paste log here

## How to run the debug tool
1. Open `debug.html` via `file://` or `http://localhost`
2. Click "compile first 5 in sequence" — this reproduces startup order
3. If a shader fails, error log (info log + truncated source) is shown
4. Click "compile all shaders" for full table, sorted slowest first
5. Share the log (especially `fs` and `link` times and any `program link failed` messages)

## Further ideas if still slow
- Make `land` code conditional: only include `GLSL.land` when `uScene==4` via `#ifdef` or separate shader variants
- Make `knot` SDF optional: split `shapeSdf` into `shapeSdfNoKnot` for shaders that don't need knot, or guard with `if (shape==KNOT)` early return already exists but compiler still parses knot code
- Use `KHR_parallel_shader_compile` extension to compile async and show "compiling..." UI instead of freeze (runner already detects extension, logs)
- Cache program binaries via `WEBGL_get_program_binary` if available (not widely supported)
- Reduce `MAXB` loops: hollow_bubbles loops 32 bubbles each with `shapeHit` (spinMat) — could early-out with bounding sphere already done

## Files changed
- `js/glsl_lib.js`: LAND_MAX_STEPS 96→64, bisections 5→4, removed 96 option
- `shaders/thick_raymarch.js`, `shaders/thick_chain.js`, `shaders/bench_chain.js`: MAXSTEPS 64→48
- `js/runner.js`: timing logs
- `debug.html`: new debug tool
