// scene.js — per-frame data feeds for shader array uniforms.
// A feed fills a preallocated Float32Array in place; it must not allocate.
// Registered under window.Feeds and referenced by name from a shader's
// `arrays: [{ name, type, count, feed }]` metadata.
//
// Feeds write as many bubbles as fit into the output buffer (out.length / 4),
// so a shader declaring 16/32/64 bubbles gets exactly the leading slice of the
// same deterministic cloud — the benchmark uses this to give every entry the
// identical scene.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const Feeds = {};

	const GA = 2.399963229728653; // golden angle
	const TAU = Math.PI * 2.0;
	const LISSAJOUS_NORM = Math.sqrt(1.0 + 1.0 + 0.81);

	// terrain scene: objects float in a band this tall, this far above the
	// highest possible ridge (see liftAboveLand)
	const LAND_GAP = 0.3, LAND_BAND = 2.5;

	// deterministic per-index constants, computed once. Each bubble has:
	//   * orbR / orbS — orbital radius and a primary speed
	//   * fxA/fxB/fxC — three independent Lissajous-like frequencies per axis
	//   * phA/phB/phC — phases per axis, golden-angle spread so no two share a path
	//   * axYaw/axPch/axRol — per-bubble axis rotation (each bubble orbits on its
	//     own tilted plane instead of every sphere spinning in the same XY disk)
	//   * driftA/driftB/driftC — low-frequency wandering frequencies for the
	//     "current" baseline drift, also golden-angle spread
	//   * driftPh — drift phase
	//   * rad / radJit — base radius + a slow breathing jitter
	// Clouds of >=64 bubbles spread wider and shrink so the scene doesn't read
	// as one crowded shell — scales as pow(n/32, 0.45).
	function makeCloud(n) {
		const orbR = new Float32Array(n);
		const orbS = new Float32Array(n);
		const fxA = new Float32Array(n);
		const fxB = new Float32Array(n);
		const fxC = new Float32Array(n);
		const phA = new Float32Array(n);
		const phB = new Float32Array(n);
		const phC = new Float32Array(n);
		const axYaw = new Float32Array(n);
		const axPch = new Float32Array(n);
		const axRol = new Float32Array(n);
		const driftA = new Float32Array(n);
		const driftB = new Float32Array(n);
		const driftC = new Float32Array(n);
		const driftPh = new Float32Array(n);
		const rad = new Float32Array(n);
		const radJit = new Float32Array(n);
		const yOff = new Float32Array(n);
		const spread = n >= 64 ? Math.pow(n / 32, 0.45) : 1.0;
		const vspread = n >= 64 ? Math.pow(n / 32, 0.35) : 1.0;
		const sizeJitter = n >= 64 ? 1.0 / Math.sqrt(n / 64) : 1.0;
		for (let i = 0; i < n; i++) {
			const f = (i + 0.5) / n;
			orbR[i] = (0.7 + 2.9 * Math.sqrt(f)) * spread;
			orbS[i] = (0.11 + 0.29 * (1 - f) + 0.05 * ((i * 7) % 5) / 5) * (n >= 64 ? 1.0 / spread : 1.0);
			// three incommensurate per-axis frequencies -> Lissajous, never repeats
			fxA[i] = 1.0 + 0.43 * ((i * 11) % 7) / 7;          // ~1.00..1.43
			fxB[i] = 0.71 + 0.51 * ((i * 5 + 2) % 5) / 5;      // ~0.71..1.22
			fxC[i] = 1.27 + 0.37 * ((i * 13 + 1) % 6) / 6;     // ~1.27..1.64
			phA[i] = GA * i;
			phB[i] = GA * i * 1.7 + 1.3;
			phC[i] = GA * i * 0.6 + 2.7;
			// each bubble orbits on its own tilted plane (yaw/pitch/roll in radians)
			axYaw[i] = GA * i * 0.9;
			axPch[i] = (Math.sin(GA * i * 0.7) - 0.5) * 1.1;   // ~[-1.1..0.6]
			axRol[i] = Math.cos(GA * i * 1.1) * 0.6;           // ~[-0.6..0.6]
			// slow wandering "current" — long-period, low-frequency drift
			driftA[i] = 0.07 + 0.05 * ((i * 17) % 4) / 4;       // ~0.07..0.12
			driftB[i] = 0.09 + 0.04 * ((i * 9 + 3) % 5) / 5;
			driftC[i] = 0.05 + 0.06 * ((i * 19 + 1) % 6) / 6;
			driftPh[i] = GA * i * 2.1 + 0.7;
			rad[i] = (0.30 + 0.60 * (0.3 + 0.7 * Math.abs(Math.sin(GA * i * 2.1)))) * sizeJitter;
			radJit[i] = 0.08 + 0.07 * ((i * 7 + 1) % 5) / 5;   // breathing depth
			yOff[i] = Math.sin(GA * i * 1.3) * 1.7 * vspread;
		}
		// per-axis motion bounds (before uSpread): the tilted Lissajous point
		// has length <= orbR * |(1, 1, 0.9)|, plus the drift and the y offset
		let orbMax = 0, yOffMax = 0;
		for (let i = 0; i < n; i++) {
			orbMax = Math.max(orbMax, orbR[i]);
			yOffMax = Math.max(yOffMax, Math.abs(yOff[i]));
		}
		const extXZ = orbMax * LISSAJOUS_NORM + 0.55;
		const extY = orbMax * LISSAJOUS_NORM + 0.40 + yOffMax;
		return { orbR, orbS, fxA, fxB, fxC, phA, phB, phC,
			axYaw, axPch, axRol, driftA, driftB, driftC, driftPh, rad, radJit, yOff, extXZ, extY };
	}
	const C32 = makeCloud(32);
	const C61 = makeCloud(61);
	const C64 = makeCloud(64);
	const C128 = makeCloud(128);

	// Deterministic initial conditions for the cage scene. Positions are stored
	// as fractions of each sphere's available half-extent; velocities are world
	// units per second. The constants never change and the feeds below evaluate
	// the exact reflected trajectory directly from time (no integration state).
	function hash01(n) {
		const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
		return x - Math.floor(x);
	}

	function makeCage(n) {
		const px = new Float32Array(n);
		const py = new Float32Array(n);
		const pz = new Float32Array(n);
		const vx = new Float32Array(n);
		const vy = new Float32Array(n);
		const vz = new Float32Array(n);
		const rad = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const k = i + 1;
			px[i] = Math.sin(GA * k * 1.13 + 0.4) * 0.68;
			py[i] = Math.sin(GA * k * 1.71 + 2.1) * 0.68;
			pz[i] = Math.cos(GA * k * 0.83 + 1.2) * 0.68;
			rad[i] = 0.25 + 0.27 * hash01(k * 5.31);

			// A uniformly distributed direction with an independently jittered
			// speed avoids the diagonal/synchronised motion common to per-axis
			// sign generators.
			const az = Math.PI * 2.0 * hash01(k * 2.17);
			const dz = hash01(k * 7.93) * 2.0 - 1.0;
			const flat = Math.sqrt(Math.max(0.0, 1.0 - dz * dz));
			const speed = 0.48 + 0.42 * hash01(k * 11.47);
			vx[i] = Math.cos(az) * flat * speed;
			vy[i] = dz * speed;
			vz[i] = Math.sin(az) * flat * speed;
		}
		return { px, py, pz, vx, vy, vz, rad };
	}

	const CAGE_INSIDE = makeCage(61);
	const CAGE_TOP_X = new Float32Array([-0.48, 0.34, 0.08]);
	const CAGE_TOP_Z = new Float32Array([-0.26, -0.38, 0.43]);
	const CAGE_TOP_R = new Float32Array([0.47, 0.36, 0.55]);
	const CAGE_TOP_V = new Float32Array([3.05, 2.55, 3.35]);
	const CAGE_TOP_PHASE = new Float32Array([0.04, 0.39, 0.73]);

	// current value of a declared param, falling back to its default
	function paramVal(meta, name, fallback) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name !== name) continue;
			const v = ps[i].value !== undefined ? ps[i].value : ps[i].def;
			return (typeof v === 'number' && isFinite(v)) ? v : fallback;
		}
		return fallback;
	}

	// vec4 per bubble: xyz = centre, w = outer radius. Scaled by uSpread / uSize
	// when the shader declares those params.
	//
	// Motion model (organic, no two bubbles trace the same path):
	//   1. per-bubble Lissajous orbit on a tilted plane:
	//        base = orbR * (cos(s*A*fxA+phA), cos(s*B*fxB+phB), cos(s*C*fxC+phC))
	//      fxA/fxB/fxC are incommensurate per-bubble frequencies, so the orbit
	//      never closes.
	//   2. tilt: rotate the orbit by yaw(axYaw) / pitch(axPch) / roll(axRol),
	//      so each bubble spins on its own plane rather than every sphere
	//      sharing the same XY disk.
	//   3. drift: a long-period "current" — three slow sinusoids per axis
	//      with independent frequencies and a per-bubble phase. Keeps the
	//      scene wandering instead of returning to a recognizable shape.
	//   4. breathing radius: rad * (1 + radJit * (sin(drift) + cos(2*drift))).
	function feedCloud(c, time, meta, out) {
		const n = Math.min(c.orbR.length, out.length >> 2);
		const spread = paramVal(meta, 'uSpread', 1.0);
		const size = paramVal(meta, 'uSize', 1.0);
		for (let i = 0; i < n; i++) {
			const s = c.orbS[i] * time;
			const r = c.orbR[i];
			// 1) raw Lissajous orbit on its local axes
			const lx = Math.cos(s * c.fxA[i] + c.phA[i]);
			const ly = Math.cos(s * c.fxB[i] + c.phB[i]);
			const lz = Math.cos(s * c.fxC[i] + c.phC[i]);
			let x = r * lx;
			let y = r * ly;
			let z = r * lz * 0.9;
			// 2) tilt the orbit plane (yaw around Y, pitch around X, roll around Z)
			const cy = Math.cos(c.axYaw[i]), sy = Math.sin(c.axYaw[i]);
			const cp = Math.cos(c.axPch[i]), sp = Math.sin(c.axPch[i]);
			const cr = Math.cos(c.axRol[i]), sr = Math.sin(c.axRol[i]);
			// roll (Z)
			const rx = cr * x - sr * y;
			const ry = sr * x + cr * y;
			x = rx; y = ry;
			// pitch (X) — y/z
			const yz1 = cp * y - sp * z;
			const yz2 = sp * y + cp * z;
			y = yz1; z = yz2;
			// yaw (Y) — x/z
			const xz1 = cy * x + sy * z;
			const xz2 = -sy * x + cy * z;
			x = xz1; z = xz2;
			// 3) low-frequency drift baseline (the "current")
			const t = time;
			const dp = c.driftPh[i];
			const dx = Math.sin(t * c.driftA[i] + dp);
			const dy = Math.sin(t * c.driftB[i] + dp * 1.7 + 0.6);
			const dz = Math.cos(t * c.driftC[i] + dp * 0.5 + 1.4);
			x += 0.55 * dx;
			y += 0.40 * dy + c.yOff[i];
			z += 0.55 * dz;
			// 4) breathing radius (two harmonics so the pulse doesn't look like a sine)
			const br = 1.0 + c.radJit[i] * (Math.sin(t * c.driftA[i] * 2.0 + dp) + 0.5 * Math.cos(t * c.driftB[i] * 3.1 + dp));
			const j = i * 4;
			out[j]     = spread * x;
			out[j + 1] = spread * y;
			out[j + 2] = spread * z;
			out[j + 3] = c.rad[i] * size * br;
		}
	}

	// Scene-aware object feeds. The scene selector owns the *behaviour* of the
	// objects, so one feed serves every motion model: the drifting cloud in
	// scenes 0..2, the elastic AABB bounce in the cage scene (3) and the cloud
	// lifted above the terrain (4). Shaders therefore never have to be rebuilt
	// when the scene changes — only the uScene uniform and the values written
	// into their existing array buffer.
	function feedSceneCloud(c, time, meta, out) {
		const scene = paramVal(meta, 'uScene', 0);
		if (scene === 3) { feedCageInside(time, meta, out); return; }
		feedCloud(c, time, meta, out);
		if (scene !== 4) return;
		const spread = paramVal(meta, 'uSpread', 1.0);
		liftAboveLand(out, Math.min(c.orbR.length, out.length >> 2), meta, c.extXZ * spread, c.extY * spread);
	}
	Feeds.bubbles = function (time, meta, out) { feedSceneCloud(C32, time, meta, out); };
	Feeds.bubbles61 = function (time, meta, out) { feedSceneCloud(C61, time, meta, out); };
	Feeds.bubbles64 = function (time, meta, out) { feedCloud(C64, time, meta, out); };
	Feeds.bubbles128 = function (time, meta, out) { feedCloud(C128, time, meta, out); };

	// Triangle-wave fold of unbounded linear motion into [-bound, +bound].
	// This is the closed form of a restitution-1 collision against two planes:
	// the normal velocity flips at a wall and tangential velocity is unchanged.
	function reflectedAxis(q, bound) {
		const period = 4.0 * bound;
		let s = (q + bound) % period;
		if (s < 0.0) s += period;
		return bound - Math.abs(s - 2.0 * bound);
	}

	function feedCageInside(time, meta, out) {
		const n = Math.min(CAGE_INSIDE.rad.length, out.length >> 2);
		const cage = Math.max(0.2, paramVal(meta, 'uCageSize', 2.2));
		const size = Math.max(0.05, paramVal(meta, 'uSize', 1.0));
		for (let i = 0; i < n; i++) {
			const radius = CAGE_INSIDE.rad[i] * size;
			const bound = Math.max(0.05, cage - radius);
			const j = i * 4;
			out[j] = reflectedAxis(CAGE_INSIDE.px[i] * bound + CAGE_INSIDE.vx[i] * time, bound);
			out[j + 1] = reflectedAxis(CAGE_INSIDE.py[i] * bound + CAGE_INSIDE.vy[i] * time, bound);
			out[j + 2] = reflectedAxis(CAGE_INSIDE.pz[i] * bound + CAGE_INSIDE.vz[i] * time, bound);
			out[j + 3] = radius;
		}
	}

	Feeds.cageInside = feedCageInside;

	// Terrain scene: an affine remap of the motion already written into `out`
	// (per-axis bounds extXZ / extY, including uSpread). x/z shrink into the
	// land footprint, y moves into a band above the highest possible ridge
	// (uLandBase + uLandAmp, because |fbm3| <= 1 in GLSL.simplex) - the same
	// conservative-bound trick as the cage, so no JS copy of the noise is
	// needed and no slider setting can push an object into the terrain.
	function liftAboveLand(out, n, meta, extXZ, extY) {
		const land = paramVal(meta, 'uLandSize', 5.0);
		const ridge = paramVal(meta, 'uLandBase', 0.0) + paramVal(meta, 'uLandAmp', 1.1);
		for (let i = 0; i < n; i++) {
			const j = i * 4;
			const w = out[j + 3];
			const k = Math.max(land - w, 0.0) / extXZ;
			out[j] *= k;
			out[j + 2] *= k;
			out[j + 1] = ridge + w + LAND_GAP + (out[j + 1] / extY + 1.0) * 0.5 * LAND_BAND;
		}
	}

	// Per-object tumble: vec4 (unit axis, angle). Axis, rate and phase are
	// deterministic per index; the angle is already advanced by `time` (and
	// wrapped, so GLSL's sin/cos never see a huge argument), so the shader and
	// the click picker read the very same orientation from this buffer.
	const SPIN_MAX = 128;
	const SPIN_AX = new Float32Array(SPIN_MAX);
	const SPIN_AY = new Float32Array(SPIN_MAX);
	const SPIN_AZ = new Float32Array(SPIN_MAX);
	const SPIN_RATE = new Float32Array(SPIN_MAX);
	const SPIN_PHASE = new Float32Array(SPIN_MAX);
	for (let i = 0; i < SPIN_MAX; i++) {
		const k = i + 1;
		const az = TAU * hash01(k * 3.71);
		const dz = hash01(k * 5.13) * 2.0 - 1.0;
		const flat = Math.sqrt(Math.max(0.0, 1.0 - dz * dz));
		SPIN_AX[i] = Math.cos(az) * flat;
		SPIN_AY[i] = dz;
		SPIN_AZ[i] = Math.sin(az) * flat;
		SPIN_RATE[i] = (0.25 + 0.45 * hash01(k * 9.29)) * ((i & 1) ? -1.0 : 1.0);
		SPIN_PHASE[i] = TAU * hash01(k * 13.7);
	}

	Feeds.spin = function (time, meta, out) {
		const n = Math.min(SPIN_MAX, out.length >> 2);
		for (let i = 0; i < n; i++) {
			const j = i * 4;
			const a = SPIN_PHASE[i] + SPIN_RATE[i] * time;
			out[j] = SPIN_AX[i];
			out[j + 1] = SPIN_AY[i];
			out[j + 2] = SPIN_AZ[i];
			out[j + 3] = a - Math.floor(a / TAU) * TAU;
		}
	};

	// Four-sphere material renderers use this feed in place of their old GLSL
	// animation. It preserves that animation in normal scenes, but switches to
	// the same reflected AABB trajectories when the cage scene is selected.
	// per-axis bounds of that animation before uSpread (see liftAboveLand)
	const FOUR_EXT_XZ = 2.3, FOUR_EXT_Y = 1.3;

	Feeds.sceneBubbles4 = function (time, meta, out) {
		const scene = paramVal(meta, 'uScene', 0);
		if (scene === 3) { feedCageInside(time, meta, out); return; }
		const s = paramVal(meta, 'uSpread', 1.0);
		out[0] = s * 0.4 * Math.sin(time * 0.50);
		out[1] = s * 0.6 * Math.sin(time * 0.90);
		out[2] = 0.0; out[3] = 1.4;
		out[4] = s * 2.0 * Math.cos(time * 0.40);
		out[5] = s * (-0.4 + 0.3 * Math.sin(time));
		out[6] = s * 0.5 * Math.sin(time * 0.6); out[7] = 1.1;
		out[8] = s * (-1.8 + 0.5 * Math.sin(time * 0.70));
		out[9] = s * 0.2 * Math.cos(time * 0.80);
		out[10] = s * -0.6; out[11] = 1.0;
		out[12] = s * 0.4 * Math.sin(time * 0.30);
		out[13] = s * 1.3 * Math.cos(time * 0.40);
		out[14] = s * 1.2; out[15] = 0.9;
		if (scene === 4) liftAboveLand(out, 4, meta, FOUR_EXT_XZ * s, FOUR_EXT_Y * s);
	};

	// The outer balls have zero initial horizontal velocity. With no friction
	// they therefore stay over fixed points on the top face while their vertical
	// trajectories repeat the exact parabola y = v*t - g*t^2/2. The sphere's
	// bottom, not its centre, contacts the face at y = cage.
	Feeds.cageTop = function (time, meta, out) {
		const n = Math.min(CAGE_TOP_R.length, out.length >> 2);
		const cage = Math.max(0.2, paramVal(meta, 'uCageSize', 2.2));
		const size = Math.max(0.05, paramVal(meta, 'uSize', 1.0));
		const gravity = Math.max(0.05, paramVal(meta, 'uGravity', 4.75));
		for (let i = 0; i < n; i++) {
			const radius = CAGE_TOP_R[i] * size;
			const room = Math.max(0.0, cage - radius);
			const launch = CAGE_TOP_V[i];
			const period = 2.0 * launch / gravity;
			const shifted = time + CAGE_TOP_PHASE[i] * period;
			const phase = shifted - Math.floor(shifted / period) * period;
			const height = Math.max(0.0, launch * phase - 0.5 * gravity * phase * phase);
			const j = i * 4;
			out[j] = CAGE_TOP_X[i] * room;
			out[j + 1] = cage + radius + height;
			out[j + 2] = CAGE_TOP_Z[i] * room;
			out[j + 3] = radius;
		}
	};

	root.Feeds = Feeds;
})(typeof window !== 'undefined' ? window : globalThis);
