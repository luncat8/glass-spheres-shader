# ld3SDl → multi-bubble

Idea only, no code.

The current shader raymarches a single warped sphere (`sdf = length(q+p) - 3.5`) and stops at the first hit. To support multiple overlapping bubbles with realistic z-order:

1. **Multi-center SDF.** Replace the single sphere with N animated centers `c_i(t)` and radii `r_i`. SDF becomes `min_i(length(p - c_i) - r_i + warp_i(p))`. Use smooth-min so merged bubbles look like soap films, not hard unions.

2. **Z-order via repeated raymarch + transmission.** After the first hit, refract the ray through the surface using the existing 6-wavelength IORs and march again from the exit point to find the next bubble. Repeat up to a small depth budget (2–3 hits).

3. **Back-to-front composite.** For each hit in depth order: compute the thin-film color (existing `resampleColor`), blend onto the running color using the Fresnel-weighted alpha (front bubble acts as a partial mirror + tinted lens over the ones behind it).

4. **Per-bubble thickness.** The `fancyCube(iChannel1, normal)` lookup stays local to each bubble — wrap it with the bubble's center so the thickness pattern rides with the bubble, not the world.

Cost grows ~2–3× per extra bubble (extra raymarch + 6 extra `refract` + `sampleCubeMap` per hop). Keep `ITERATIONS` and `WAVELENGTHS` small; cap hit depth at 2–3 to stay interactive on integrated GPUs.
