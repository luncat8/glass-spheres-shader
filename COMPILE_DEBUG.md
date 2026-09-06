# Compile slowness investigation

## Reported symptom
- The first compile of the scene-aware shaders was extremely slow, especially `hollow_bubbles` and the raymarchers.
- The browser could freeze, then report `program link failed`.
- After a successful compile, the driver cache made subsequent attempts much faster.

## Cause
The shape and heightmap work added a large amount of optional GLSL to every scene-aware program. The default checker scene still handed the driver the simplex terrain marcher, lake refraction, cube/tetra code and knot SDF. Some WebKit/Chromium drivers optimise those dynamic branches while answering `COMPILE_STATUS` or `LINK_STATUS`; on failure the context could then make later programs fail too.

## Current mitigation
- `GLSL.simplex` and the full `GLSL.land` implementation are guarded by `USE_TERRAIN`.
  Non-terrain programs get small no-op land entry points instead of the 64-step marcher.
- `GLSL.shape` is guarded by `SHAPE_MODE`. The default sphere program does not compile cube, tetra or knot implementations.
- `js/runner.js` emits the selected `USE_TERRAIN` / `SHAPE_MODE` variant. The default sphere/sky program is compiled at startup; terrain and non-sphere shapes compile only when selected and are cached for the current shader.
- The old program is kept until a new program has linked. Failed shaders are cleaned up, so one optional failure does not cascade into the next selection.
- Compile/link timing includes the status query. That query is where asynchronous driver compilation can block, so the log now identifies the real slow operation.
- `debug.html` compiles the lightweight default variants, stops on a lost context, and does not attempt to link a shader after its compile already failed.

## Diagnostic tool
1. Open `debug.html` via `file://` or `http://localhost`.
2. Click **compile first 5 in sequence** to reproduce the startup order.
3. Click **compile all shaders** for the complete table.
4. Share the `fs`, `link`, `total`, and `ok` values if a default variant is still slow.

Terrain is intentionally compiled on demand because it is the expensive feature. If its first selection is still slow on an integrated GPU, choose the `32` land-step option; this changes rendering cost without making the normal startup pay for it.
