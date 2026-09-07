# Compile performance — status and how to measure it

## Reported symptom
- Switching shape / scene took 2–3 s and choosing the glass-land scene was very
  long: every new variant was compiled and linked by the driver.
- `analytic_layers` linked in ~20 s on an integrated-GPU driver even for the
  default sphere program; after one successful compile the driver cache made
  the same variant fast again. So the cost is driver-side compilation, not
  rendering, and it is CPU-bound: an RTX 3060 does not help.
- `WebGL: INVALID_ENUM: getShaderParameter: invalid parameter name` and a
  freeze at startup when polling with `gl.COMPLETION_STATUS_KHR`.

## Root causes found (and fixed here)

### 1. The completion enum was taken from the wrong object
`COMPLETION_STATUS_KHR` is a member of the *extension object*, not of the
context on every implementation (`ext.COMPLETION_STATUS_KHR`, per the WebGL
extension spec; MDN sample code queries `gl.getProgramParameter(p,
ext.COMPLETION_STATUS_KHR)`). Passing `gl.COMPLETION_STATUS_KHR` where that
property is undefined produces exactly the reported INVALID_ENUM. The runner
now stores the extension object at `init()` and polls with
`Runner.completionStatus`; a non-boolean answer from the driver fails the job
with a readable error instead of polling forever.

### 2. Startup was still synchronous
`Runner.select()` built the first program with `finishJobSync()` on the boot
path, and `getShaderParameter(COMPILE_STATUS)`/`LINK_STATUS` block until the
driver finishes — the startup freeze. Boot now goes through the same polled
path as every shape/scene switch: the page stays responsive, `frame()` renders
nothing until the program links, and the status line says "compiling…" until
the swap.

### 3. The driver unrolls constant-bound loops
ANGLE (D3D/HLSL and Metal backends) tries to unroll `for (i < CONST)` loops;
with `break` on a uniform it still attempts the unroll at compile time and
FXC can spend tens of seconds on a 10 × 32 (hollow bubbles) or 48-step ×
4-sphere-SDF (thick raymarch) unroll. Every object/march loop bound is now
driven from a uniform with a clamped cap, so the trip count is unknown at
compile time and the driver emits a real loop. Scene shaders use `uCount`,
`uLayers`, `uTopCount`, `uLandSteps`, `uSteps`; the own/orig shaders use
`uIterations`/`uAASamples` (`multi_thinfilm`, `ld3SDl`) and
`uCellRange`/`uBlurSamples` (`llsSDf`). Runtime behaviour is unchanged: the
same scales are the old maxima (the blur taps keep the original 0.8 total
weight whatever the tap count).

### 4. Struct/inout plumbing in `analytic_layers`
The nearest-three-layers code was a 7-field struct returned by value and moved
through `inout` struct parameters; then a flat version with 7 inout scalars
per layer (28 parameters). Both shapes push ANGLE's translator into its slow
path. Layers are now plain fixed-size arrays (`vec2 span[3]`, normals, sphere,
`mk = (id, kind)`) with one small insert helper — no structs, no
28-parameter functions.

### 5. Speculative variants amplified (but did not cause) the slow compile
After every shader selection the runner queued every terrain/shape variant in
the background. `KHR_parallel_shader_compile` keeps JavaScript responsive; it
does **not** promise independent compiler capacity. ANGLE and the native driver
can serialize or heavily contend these jobs. The diagnostic trace showing a
`hollow_bubbles 1:0` background job taking 272 s while active jobs also ran is
the signature: the app was asking the driver to optimize large programs the
user had never selected. This explains the 272 s queue/contended result, but
not the underlying cold compile itself; the cold compile is still work done by
the browser's ANGLE/native shader compiler.

Background priming is now disabled. Variants compile only on demand and remain
cached in the current shader's variant map after first use. This removes the
self-inflicted queue and makes active timing identify the actual requested
program.

### 6. Hybrid-GPU laptops
The WebGL context is now created with
`powerPreference: 'high-performance'` so a laptop with an RTX 3060 plus an
integrated GPU does not silently hand WebGL to the iGPU — a "good GPU" that
the app never used.

## What is left to verify (on Chrome 150 / RTX 3060+)

1. `debug.html` reports whether `KHR_parallel_shader_compile` is available,
   whether the context exposes `gl.COMPLETION_STATUS_KHR`, and per-stage
   timing: `compileCall`, `linkCall`, and `pollMax` (a large `pollMax` means a
   poll call is stalling — the extension is effectively synchronous there).
2. `compile all shaders` shows the boot programs (terrain=0, sphere) — if any
   is still > ~500 ms, the driver path is still slow and the remaining
   candidates are the big shared libraries in `js/glsl_lib.js` (`GLSL.env`'s
   four themes, `GLSL.cageOverlay`'s twelve wire edges) that every scene
   program carries, and the per-pixel recursive `shapeHit` calls. What
   remains constant-bound is only 2–4 iteration outer loops (`HOPS`,
   `BOUNCES`, `NB`, the `LAYERS` pass, the 4-bisection refinements): they can
   be unrolled safely because their bodies already run uniform-bound loops,
   so there is no nested unroll to blow up.
3. `compile every scene/shape variant of the first shader` is now an explicit
   stress test only; the application no longer does this speculative work.
4. Enable `unique source (cold-cache probe)` (the default) to add a different
   preprocessor nonce on each diagnostic run. This avoids reuse under a
   source-keyed driver cache. A fresh browser profile remains the strongest
   cold-cache test because WebGL cannot clear opaque OS/driver binary caches.
5. Rows now report `compileWait` and `linkWait`, not just the near-zero API-call
   durations. The larger wait identifies whether translation/compilation or
   program linking dominated. `total` can exceed their sum by at most polling
   cadence and bookkeeping.
6. Startup and shape/scene switching should no longer freeze the page; the
   status line stays "compiling…" until the swap. Report `compileWait`,
   `linkWait`, `total`, and `pollMax` instead of wall-clock guesses.
