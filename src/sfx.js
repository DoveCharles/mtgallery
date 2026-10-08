import * as THREE from 'three';

// The starting area's sounds, from the Unity project's Audio folder (the long WAVs
// re-encoded to AAC): the drop, the corridor drone, footsteps, the keypad's clicks and
// verdicts and the doors. One-shots play flat, or from an object when one is given: the keypad's
// sounds come from the keypad (each click from its key), the doors' from the door.
// Sounds still loading when they are due are skipped, as are any before the first click
// has started the audio context.
// While you're in the starting area every one-shot also feeds a reverb (see corridorImpulse)
// for its narrow concrete corridor.

const FILES = {
  drop: 'drop.m4a',
  drone: 'drone.m4a',
  incorrect: 'incorrect.mp3',
  doorSuccess: 'door-success.m4a',
  doorClose: 'door-close.m4a',
  click1: 'click1.ogg',
  click2: 'click2.ogg',
  click3: 'click3.ogg',
  click4: 'click4.ogg',
  click5: 'click5.ogg',
  click6: 'click6.ogg',
};
const CLICKS = ['click1', 'click2', 'click3', 'click4', 'click5', 'click6'];
const STEPS = Array.from({ length: 12 }, (_, i) => `step${i + 1}`);
for (const s of STEPS) FILES[s] = `${s}.ogg`;
const DRONE_VOLUME = 0.166; // as on the Unity AudioSource
const DRONE_FADE = 1.5; // seconds, in and out
const REF_DISTANCE = 1; // m: full volume within this, then falling off with distance
const INCORRECT_VOLUME = 0.35;
// Footsteps, as the Unity FootstepAudio was set up (its AudioSource was muted, so the
// volume is new).
const STEP_INTERVAL = 0.6; // seconds, at walking speed
const STEP_PITCH = [1.05, 2];
const STEP_VOLUME = 0.4;
const REVERB_WET = 0.45;
const REVERB_FADE = 0.3; // seconds, going between the corridor and a room

export class Sfx {
  buffers = {};
  drone = null;
  droneOn = false;
  stepTimer = 0;
  lastStep = -1;

  constructor(listener) {
    this.listener = listener;
    const ctx = listener.context;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = corridorImpulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.reverb.connect(this.wet).connect(listener.getInput());
    this.reverbOn = false;
    const loader = new THREE.AudioLoader();
    for (const [name, file] of Object.entries(FILES)) {
      loader.loadAsync(`/audio/${file}`).then(
        (b) => (this.buffers[name] = b),
        () => {},
      );
    }
  }

  get ready() {
    return this.listener.context.state === 'running';
  }

  play(name, { at, volume = 1, rate = 1, refDistance = REF_DISTANCE } = {}) {
    const buffer = this.buffers[name];
    if (!buffer || !this.ready) return;
    const sound = at ? new THREE.PositionalAudio(this.listener) : new THREE.Audio(this.listener);
    sound.setBuffer(buffer).setVolume(volume).setPlaybackRate(rate);
    if (at) {
      sound.setRefDistance(refDistance);
      at.add(sound);
    }
    sound.getOutput().connect(this.reverb);
    sound.onEnded = () => {
      sound.isPlaying = false;
      sound.removeFromParent();
      sound.disconnect();
    };
    sound.play();
  }

  click(at) {
    this.play(CLICKS[Math.floor(Math.random() * CLICKS.length)], { at });
  }

  incorrect(at) {
    this.play('incorrect', { at, volume: INCORRECT_VOLUME });
  }

  // A step every STEP_INTERVAL while walking (sooner when running), the first straight
  // away, never the same clip twice running. `speed` is relative to walking. Call every frame.
  footsteps(dt, walking, speed = 1) {
    if (!walking) return void (this.stepTimer = 0);
    this.stepTimer -= dt;
    if (this.stepTimer > 0) return;
    this.stepTimer = STEP_INTERVAL / Math.max(speed, 1);
    let i;
    do i = Math.floor(Math.random() * STEPS.length);
    while (i === this.lastStep);
    this.lastStep = i;
    this.play(STEPS[i], { volume: STEP_VOLUME, rate: THREE.MathUtils.randFloat(...STEP_PITCH) });
  }

  // The corridor's reverb, on while you're in the starting area. Call every frame.
  setReverb(on) {
    if (on === this.reverbOn) return;
    this.reverbOn = on;
    const gain = this.wet.gain;
    const now = this.listener.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(on ? REVERB_WET : 0, now + REVERB_FADE);
  }

  // The drone loops while `on`, fading in and out. Call every frame.
  setDrone(on) {
    if (on === this.droneOn) return;
    if (on && !this.drone) {
      const buffer = this.buffers.drone;
      if (!buffer || !this.ready) return; // try again next frame
      this.drone = new THREE.Audio(this.listener).setBuffer(buffer).setLoop(true).setVolume(0);
      // AAC pads the start and end with silence, which would leave a gap at every loop.
      const [start, end] = audibleRange(buffer);
      this.drone.setLoopStart(start).setLoopEnd(end);
      this.drone.offset = start;
      this.drone.play();
    }
    if (!this.drone) return;
    this.droneOn = on;
    const gain = this.drone.gain.gain;
    const now = this.listener.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(on ? DRONE_VOLUME : 0, now + DRONE_FADE);
  }
}

// Seconds from the first to the last sample that isn't (near) silent.
function audibleRange(buffer, threshold = 1e-4) {
  const data = buffer.getChannelData(0);
  let a = 0;
  let b = data.length - 1;
  while (a < b && Math.abs(data[a]) < threshold) a++;
  while (b > a && Math.abs(data[b]) < threshold) b--;
  return [a / buffer.sampleRate, (b + 1) / buffer.sampleRate];
}

// A made-up impulse response for a long, narrow concrete corridor: a short pre-delay, a
// flutter echo between the close side walls, a slap back off the far ends, and a dense
// tail that dies away over RT60 seconds and darkens as it goes (hard concrete loses the
// highs slowly, so it stays fairly bright). Each channel gets its own noise and timings
// so the tail is wide.
const RT60 = 1.6; // seconds
const CORRIDOR_WIDTH = 3; // metres, wall to wall (measured in the level)
const CORRIDOR_LENGTH = 18;
const SOUND_SPEED = 343;
function corridorImpulse(ctx) {
  const rate = ctx.sampleRate;
  const length = Math.ceil(rate * RT60 * 1.2);
  const buffer = ctx.createBuffer(2, length, rate);
  const decay = Math.log(1000) / RT60; // -60 dB over RT60
  const preDelay = Math.round(rate * 0.006);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    // Diffuse tail, low-passed more and more as it decays.
    let lp = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / rate;
      const k = 0.25 + 0.6 * Math.min(t / RT60, 1); // one-pole smoothing, 0 = none
      lp += (1 - k) * ((Math.random() * 2 - 1) - lp);
      data[i] = lp * Math.exp(-decay * t) * 0.5;
    }
    // Flutter: the sound bouncing between the side walls, a little off-beat per channel.
    const flutter = (2 * CORRIDOR_WIDTH) / SOUND_SPEED;
    for (let n = 1, t = flutter * (c ? 0.55 : 0.5); t < RT60 * 0.6; n++, t += flutter * (1 + (Math.random() - 0.5) * 0.08)) {
      const i = preDelay + Math.round(t * rate);
      data[i] += (n % 2 ? 0.7 : 0.5) * Math.exp(-decay * 1.6 * t);
    }
    // Slap back off the corridor's ends.
    for (const [d, g] of [[CORRIDOR_LENGTH * 0.9, 0.35], [CORRIDOR_LENGTH * 1.8, 0.18]]) {
      const i = preDelay + Math.round((d / SOUND_SPEED) * rate * (c ? 1.03 : 1));
      if (i < length) data[i] += g;
    }
  }
  // Fade the very end to nothing.
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    const fade = Math.round(rate * 0.1);
    for (let i = 0; i < fade; i++) data[length - 1 - i] *= i / fade;
  }
  return buffer;
}
