# Shader compilation: cause, changes, and reproducible measurement

## What the Chrome 151 timings establish

`analytic_layers 0:1` took about **44.6 seconds**, with about **19 ms** waiting
for the WebGL shader compile stage and **44.6 seconds** waiting for the linked
program. The sphere variant took about **13 seconds**. API calls and completion
polls themselves were short.

That identifies the **program/backend stage**, not slow JavaScript polling or
slow drawing. `linkProgram` can include backend shader generation, native
compilation, optimization and executable creation. It is not merely resolving
symbols. The WebGL timers cannot identify the particular native optimizer pass
or distinguish all of those operations. Compilation is largely CPU-side work;
an RTX's rendering throughput does not make a pathologically expanded shader
cheap to compile.

`WebKit WebGL` is a masked renderer string, not the adapter/backend identity.
`debug.html` now reports `WEBGL_debug_renderer_info` when available.
`powerPreference: 'high-performance'` is only a selection hint, not proof of
which GPU was chosen and not a compiler-speed fix.

## The source-level problem the earlier changes missed

Making the long inner loops uniform-bound did **not** remove the larger
expansion around them. The important size is the optimizer's expanded code and
live state, not the roughly 30 KB input string:

- **AA:** `analytic_layers` and `hollow_bubbles` had a constant four-tap loop
  containing a full scene trace, plus another trace in the `else` branch.
  Inlining/unrolling can produce **five copies of the whole scene**, even when
  the AA uniform defaults to off. Uniform defaults are not compile-time values.
- **Layers:** `analytic_layers` manually called the material path three times.
  Combined with AA, that could create **15 material paths**, each calling the
  multi-theme procedural environment. Its insertion loop also moved five arrays
  containing **42 scalar components** through `out`/`inout` parameters.
- **Shared cage:** twelve explicit `cageEdgeHit` calls chained conditional updates
  of the nearest depth/mask, duplicated again at every expanded scene trace.
- **Cube/tetra:** each `shapeHit` chained six/four branch-heavy `planeClip` calls
  with mutable interval and normal outputs. The more complicated body was copied
  into the same outer paths, explaining why these variants are strong suspects
  for the additional cost over spheres.
- **Other glass shaders:** `thick_raymarch` duplicated its primary/bounce shading
  path; `thick_chain` had a constant outer hop count. `thick_analytic` shaded and
  sorted four opaque results even though only the nearest result survived.

A 2–4 iteration outer loop is **not automatically safe** because its inner loop
is dynamic. The inner loop's entire body can still be copied for each outer
iteration. Nor are GLSL structs inherently slow or arrays inherently fast: the
amount of copied state and control flow matters. There is no shader recursion
here, and no portable WebGL GLSL `noinline`/`nounroll` directive. Actual lowering
is compiler/backend-dependent; the old claim that the root problem was already
fixed was premature.

## Structural changes (not lower quality settings)

- One trace call site with a uniform-derived 1-or-4 sample count in both AA
  shaders. Same sample positions and weights.
- One data-dependent, back-to-front material loop in `analytic_layers`, bounded
  by the number of retained hits. Sort only `(entry, exit, id, kind)` records;
  reconstruct normals for at most three survivors, not every insertion.
- One cage-edge call inside a runtime-bounded loop, preserving all twelve edges
  and their original order. The fixed budget is a hidden uniform.
- Cube intersections use slab intervals; tetra intersections reduce four plane
  intervals together, rather than chaining `inout` clipping calls. Parallel
  face rays avoid division-by-zero/NaN cases. Explicit sphere hits still work
  inside a cube/tetra program (needed for cage top balls and their selection;
  the previous specialization incorrectly ignored that argument).
- One primary/bounce material call site in `thick_raymarch`; runtime hop bounds
  in `thick_chain`; nearest-hit selection **before** shading in `thick_analytic`.

Object limits, three retained transparent layers, AA taps, reflection/hop
budgets, terrain march budgets, materials and all supported variants remain.
There is no speculative background compilation. The extension-based waiting and
`ext.COMPLETION_STATUS_KHR` fix remain, but those address responsiveness, not
the amount of compilation work.

## Validation and its limits

Local comparison: **Chromium 149, Linux, ANGLE/Vulkan/SwiftShader**, not the
reported Chrome 151 / RTX driver. Median of three serialized batches per
revision; each batch started a fresh browser process with
`--disable-gpu-shader-disk-cache`. Fixed populated scene, 32 × 32 pixels, AA off.
Times include shader/program creation and the **first draw/readback**, because
this backend defers most native work until drawing:

| Non-terrain program | Before | After |
| --- | ---: | ---: |
| analytic_layers / sphere | 1266 ms | 345 ms |
| analytic_layers / cube | 1415 ms | 270 ms |
| analytic_layers / tetra | 1331 ms | 277 ms |
| hollow_bubbles / sphere | 813 ms | 333 ms |
| thick_analytic / sphere | 589 ms | 212 ms |
| thick_raymarch / sphere | 549 ms | 278 ms |
| thick_chain / sphere | 285 ms | 236 ms |

Component experiments on the old analytic cube source also reduced first-use
cost when changing AA or layer composition independently. This supports the
code-expansion diagnosis; **it is not evidence of a particular RTX link time**.
The Chrome 151 / actual GPU/backend cold result is still needed. Shader source
changes alone cannot guarantee a sub-500-ms compile on every driver.

Validation tools:

- `node --test tests/*.test.cjs` — source equivalence, probe isolation, retained
  budgets, async/sync timing, failure handling, correct extension enum and cleanup.
- Optional browser checks: install dev-only `playwright`, install its Chromium,
  then `node tests/webgl-smoke.cjs`. `CHROME` selects another installed executable;
  `CHROME_ARGS` accepts a JSON array of flags. No runtime dependencies or build.
  Checks **43 supported programs** through link and first draw, component probes,
  the diagnostic UI via `file://`, and **726 GPU geometry cases** against scalar
  half-space/sphere intersections (including inside, parallel, rotated and
  sphere-override rays).
- Local before/after image comparisons were pixel-identical for the tested
  non-terrain sphere images of all five changed renderers, and analytic cube /
  tetra checker images with four-sample AA. The corrected non-sphere cage-top
  geometry is an intentional visual difference.

## Measuring the actual cold path

1. **Do not treat reload, disabled HTTP cache, new WebGL context, a comment, or
   an unused nonce `#define` as a cold native compile.** The unused nonce in the
   previous debug page disappeared during preprocessing; a downstream cache
   could still see identical input. There are multiple independent cache levels.
2. For a controlled exact-source run, use a **fresh browser process and empty
   disposable profile**, with shader disk caching disabled. General launch form:
   `chrome --user-data-dir=<empty-temporary-directory> --disable-gpu-shader-disk-cache`.
   Do not use an existing profile/process, and do not remove your personal profile.
   Browser flags are implementation details; record browser version and flags.
3. Opaque OS/vendor caches can still survive a fresh profile. For strict native
   cold measurements, also use the driver's supported cache controls, if
   available; record and restore those settings. **WebGL cannot flush those
   caches or attest that a compile was cold.**
4. Open `debug.html` alone, keep it foreground, select `analytic_layers`, then
   cube or tetra, non-terrain. Run **compile selected variant** before the bulk
   tests. Avoid other app/diagnostic compile jobs at the same time.
5. **Exact production source** uses the runner's very same assembler.
   **Live-literal cache probe** changes a used final RGB multiplier, so it survives
   preprocessing into compiler input. It intentionally changes output and is
   still only a cache probe, not a guaranteed miss at every layer.
6. Save the report. It includes source hashes (FNV-1a identifiers, not cache-miss
   certificates), exact GLSL, browser/backend identity, compile/link call times,
   both stage waits, and maximum completion-poll duration across both shaders
   and the program. Stage waits **include** the API calls; do not add them twice.
   Poll cadence and tab scheduling limit precision of short timings.
7. Optionally capture **translated source**. `WEBGL_debug_shaders` may return HLSL,
   GLSL or an intermediate representation depending on the backend; it is not
   native machine code or an optimizer trace. Capture happens after completion,
   outside the reported compile/link interval.
8. Optionally time **first draw/readback** to catch deferred native compilation.
   This draws one diagnostic pixel with default scalar parameters and placeholder
   objects/textures. It includes setup and synchronization, can
   block the page, and is **not an FPS benchmark**. A `gl.finish()` call alone
   need not force a client-side wait in Chromium; the readback does.
9. **Compare components** removes one component at a time (environment, wires,
   glass material, terrain, or uses bounding spheres). These are deliberately
   non-equivalent diagnostic shaders, never production settings. Compare them
   under the same cache conditions. Stop waits for the current job; deletion
   cannot reliably cancel a native compile. After timeout/context loss, restart
   the browser before another controlled run.
