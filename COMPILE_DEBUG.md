# current status

WebGL: INVALID_ENUM: getShaderParameter: invalid parameter name

if i use
if (gl.COMPLETION_STATUS_KHR) ensurePoll();
...

it freeze at start

also need better investigate what really took so long time to startup these scenes or object type switching

# Compile slowness investigation

## Reported symptom
- Switching shape took 2–3 s and choosing the glass-land (terrain) scene was very
  long, because each new scene/shape variant was compiled and linked on the main
  thread, freezing the page.
- The first compile of the scene-aware shaders was extremely slow on some
  drivers (`analytic_layers` linked in ~20 s on an integrated GPU even for the
  default sphere/sky program); after a successful compile the driver cache made
  the same variant fast again.
- A fast result (e.g. `hollow_bubbles` at 6 ms) only meant that variant had
  already been compiled earlier in the session.

## Cause
The shape and heightmap work added a large amount of optional GLSL to every
scene-aware program. The default checker scene still handed the driver the
simplex terrain marcher, lake refraction, cube/tetra code and knot SDF. Some
WebKit/Chromium drivers optimise those dynamic branches while answering
`COMPILE_STATUS` or `LINK_STATUS`; on failure the context could then make later
programs fail too.

Making terrain/shape compile-time variants (`USE_TERRAIN`, `SHAPE_MODE`) cut the
unreachable code out of the default program, but it did not remove the freeze:
every first switch to a new shape or to the terrain scene still compiled a fresh
whole-program variant synchronously on the main thread, and the driver cache
keys on the final source, so each distinct variant is a fresh link.

## Current mitigation
- `GLSL.simplex` and the full `GLSL.land` implementation are guarded by
  `USE_TERRAIN`. Non-terrain programs get small no-op land entry points instead
  of the 64-step marcher.
- `GLSL.shape` is guarded by `SHAPE_MODE`. The default sphere program does not
  compile cube, tetra or knot implementations.
- `js/runner.js` compiles and links variants asynchronously through
  `KHR_parallel_shader_compile` where the browser offers it. While a new variant
  links on driver threads, the previous program keeps rendering and the swap
  happens only once the new program has actually linked — switching shape,
  scene or shader no longer freezes the page. Without the extension the old
  synchronous behaviour is preserved instead of regressed.
- `js/runner.js` also primes variants in the background: once a shader is
  active it compiles the other shapes and the glass-land (terrain) variant of
  the current shape, one at a time, so a later scene/shape click usually finds a
  linked program already waiting (instant). The terrain variant is primed first
  because it is the most expensive switch.
- The old program is kept until a new one has linked; a failed or superseded
  compile is cleaned up and never overwrites a newer user choice, so one failure
  does not cascade into the next selection.
- `analytic_layers` no longer models its nearest-three-layers with a `Hit`
  struct returned by value and shuffled through `inout` struct parameters: that
  was the one structural difference between it (20 s link) and `hollow_bubbles`
  (6 ms link) sharing the same GLSL, and it forced the driver's translator down
  its struct-copy slow path. The layers are now flat out/inout scalars and
  vectors, which link like the other scene shaders.
- `debug.html` reports whether `KHR_parallel_shader_compile` is available and
  keeps timing the raw compile/link of the default variants.

## Diagnostic tool
1. Open `debug.html` via `file://` or `http://localhost`.
2. Check the `KHR_parallel_shader_compile` line to confirm the app's async path
   is available on this browser.
3. Click **compile first 5 in sequence** to reproduce the startup order, or
   **compile all shaders** for the complete table.
4. Share the `fs`, `link`, `total`, and `ok` values if a default variant is
   still slow.

Terrain is intentionally compiled on demand because it is the expensive feature.
If its first selection is still slow on an integrated GPU, choose the `32`
land-step option; this changes rendering cost without making the normal startup
pay for it.
