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

### 5. Hybrid-GPU laptops
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
3. `compile every scene/shape variant of the first shader` reproduces what
   background priming does; wait for the run and compare the slowest variant.
4. First compile after browser start includes the driver's shader cache
   miss; the second run on the same variant is expected to be fast — that is
   not "fixed", it is the cache. Judge by the *first* run in a fresh profile.
5. Startup and shape/scene switching should no longer freeze the page; the
   status line stays "compiling…" until the swap. Report the `total`/`pollMax`
   numbers instead of wall-clock guesses.
