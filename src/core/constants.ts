/**
 * Tuning constants. Anything a designer would want to twiddle lives here or in
 * `src/content/`. Nothing in this file may import from elsewhere in the project.
 */

// ---------------------------------------------------------------- simulation

/** World pixels per tile. */
export const TILE = 32;

/** Fixed simulation tick, in milliseconds. 60 Hz. */
export const STEP = 1000 / 60;

/** Seconds per tick, precomputed (systems take `dt` in seconds). */
export const STEP_S = STEP / 1000;

/** Most catch-up steps we will run in one frame before giving up on the debt. */
export const MAX_STEPS = 5;

/** A frame longer than this is clamped (slow machine, GC pause). */
export const MAX_FRAME_MS = 100;

/** A frame longer than this had its time thrown away entirely (tab blur, sleep). */
export const DISCARD_FRAME_MS = 250;

// ------------------------------------------------------------------- player

export const PLAYER_RADIUS = 11;
export const PLAYER_BASE_SPEED = 180; // px/s
export const PLAYER_BASE_HP = 100;
export const PLAYER_ACCEL = 2600; // px/s^2, how fast you reach top speed
export const PLAYER_FRICTION = 3000; // px/s^2, how fast you stop
export const PLAYER_LIGHT_RADIUS = 210;

/** Invulnerability after taking a hit, ms. */
export const IFRAME_ON_HIT = 700;

// Dash / dodge
export const DASH_MS = 180;
export const DASH_SPEED = 620;
export const DASH_IFRAME_MS = DASH_MS + 60;
export const DASH_CD = 1100;

/** Input buffering windows, ms. A press this long before it can fire still counts. */
export const ATTACK_BUFFER_MS = 150;
export const DASH_BUFFER_MS = 120;

// ------------------------------------------------------------------- combat

/** Knockback velocity is multiplied by this each tick. ~95% gone in 250ms. */
export const KNOCKBACK_DECAY = 0.82;

/** Below this magnitude (px/s) knockback is snapped to zero. */
export const KNOCKBACK_EPSILON = 4;

export const ENEMY_STUN_LIGHT = 120;
export const ENEMY_STUN_HEAVY = 220;
export const HIT_FLASH_MS = 80;

/** Cooldown an enemy takes after landing contact damage. Stops swarm shredding. */
export const CONTACT_DAMAGE_CD = 600;

export const HITSTOP_LIGHT = 60;
export const HITSTOP_HEAVY = 100;
export const HITSTOP_PLAYER_HIT = 110;

/** After the player is hit, run at this timescale briefly for a slow-mo punch. */
export const PLAYER_HIT_TIMESCALE = 0.35;
export const PLAYER_HIT_TIMESCALE_MS = 40;

// Screen shake
export const TRAUMA_HIT_DEALT = 0.12;
export const TRAUMA_HIT_TAKEN = 0.35;
export const TRAUMA_EXPLOSION = 0.6;
export const TRAUMA_DECAY = 1.8; // per second
export const TRAUMA_MAX_OFFSET = 12; // px at trauma 1.0

// ------------------------------------------------------------------ rendering

/** Logical view height in world px. Zoom is derived from this. */
export const TARGET_VIEW_HEIGHT = 380;

/** Device pixel ratio is capped here; 3x retina triples fill cost for no gain. */
export const MAX_DPR = 2;

/** Above this many canvas pixels, drop the light buffer to a third resolution. */
export const LIGHT_DOWNGRADE_PIXELS = 2_300_000;

export const CAMERA_DEADZONE_W = 64; // world px, half-extent
export const CAMERA_DEADZONE_H = 44;
export const CAMERA_FOLLOW_RATE = 8; // exponential, per second
export const CAMERA_LOOKAHEAD = 18; // world px toward aim

// Effect caps. Exceeding these evicts the oldest rather than growing.
export const MAX_PARTICLES = 800;
export const MAX_DAMAGE_NUMBERS = 48;
export const MAX_DECALS = 200;

/** If frame p99 exceeds this for a while, particle budget halves. */
export const PERF_DEGRADE_MS = 14;

// ---------------------------------------------------------------- persistence

/**
 * localStorage is shared across every project on `<user>.github.io`, so the
 * prefix is load-bearing, not cosmetic.
 */
export const SAVE_KEY = 'sg.save';
export const SAVE_CORRUPT_KEY = 'sg.save.corrupt';
export const SAVE_VERSION = 1;
