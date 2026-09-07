## glass bubbles shaders

choose settings, copy prompt to implement it in your webGL project

![screenshot](screenshot.avif)

## open issues

slow startup linking shaders, probably caused by code branching in GLSL. especially heightmap land - up to 60 sec cold compilation on 2026 PC. next run is instant, 200+FPS on real GPU

## webGPU port

## workflow

search internet other sites that better support vertex shader and have examples multiple glass bubbles in 3d

hollow glass bubbles with specific thickness of wall (GUI slider)

implement/add system to run these shaders

expose settings as uniforms instead of #define but only that which is not cause branching

fix/implement camera mouse/pointer to be similar to our standard convention

if need - update copy prompt functions to support it. better make it universal.


if there is no gpu in sandbox. and if available  
/tools_GPU/
use it for debug