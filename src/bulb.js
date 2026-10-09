import * as THREE from 'three';

// The flickering lightbulb (the "Lightbulb" object, with its "Filament" child), ported from
// the old Unity RealisticFlickerEmissionLightAndGlass with the values it had in the scene.
// Like a bulb with a loose contact, it mostly burns steadily (with a faint wavering), then
// stutters: a burst of quick cut-outs and catches, now and then a longer blackout that it
// sputters back out of. The filament heats faster than it cools, and the glass follows more
// slowly still. The brightness drives the filament's glow, the glass's, a point light and
// the buzz's volume, and every time the bulb comes back on (crosses ON) it clinks. The light
// (and the glass) is orange, shimmering slowly between deep orange and gold, iridescent.

const STEADY = [0.6, 4]; // s the bulb burns between stutters
const BURST = [2, 7]; // cut-outs in a stutter
const CUT = [0.02, 0.09]; // s each cut-out lasts
const CATCH = [0.03, 0.2]; // s it catches for in between
const BLACKOUT = 0.15; // chance a stutter ends in a blackout
const BLACKOUT_LENGTH = [0.3, 1.6]; // s
const WAVER = 0.04; // the steady burn's wavering
const RISE = 50; // per second, as the filament heats
const FALL = 30; // per second, as it cools
const GLASS_EASE = 6;

const FILAMENT_COLOR = new THREE.Color(1, 0.5913, 0.1569);
const FILAMENT_GLOW = 220; // emissive strength at full (as exported from Blender)
const GLASS_GLOW = 0.4; // emissive intensity at full
// The light's colour, as HSL: amber orange, its hue drifting by up to SHIMMER either way
// (deeper orange to gold) over a few seconds.
const LIGHT_HSL = { h: 0.095, s: 0.95, l: 0.6 };
const SHIMMER = 0.025;
const LIGHT = 300; // candela at full (the bulb is ~10 m across)
const LIGHT_RANGE = 40; // m

const BUZZ_VOLUME = 1;
const CLINK_VOLUME = 0.6;
const ON = 0.2; // brightness that counts as "on"
const CLINK_COOLDOWN = 0.1; // s
const CLINK_DELAY = 0.03;
const SOUND_REF = 1.25; // m: full volume within this
const BUZZ_RANGE = 20; // m: silent beyond this (fading linearly, as in Unity)
const CLINK_RANGE = 17;

let sounds;

export async function addFlickeringBulb(level, listener, world) {
  const bulb = level.root.getObjectByName('Lightbulb');
  const filament = bulb?.getObjectByName('Filament');
  if (!filament) return null;
  sounds ??= Promise.all(
    ['buzz.wav', 'clink1.m4a', 'clink2.m4a', 'clink3.m4a'].map((f) => new THREE.AudioLoader().loadAsync(`/audio/${f}`).catch(() => null)),
  );
  const [buzzBuffer, ...clinkBuffers] = await sounds;
  const clinks = clinkBuffers.filter(Boolean);

  // The filament's glowing part and the glass, each with its own copy of its material.
  const glows = [];
  filament.traverse((o) => o.isMesh && o.material.emissiveIntensity !== undefined && o.material.emissive.getHex() && glows.push(o));
  for (const m of glows) {
    m.material = m.material.clone();
    m.material.emissive.copy(FILAMENT_COLOR);
  }
  const glass = bulb.isMesh ? bulb : null;
  if (glass) {
    glass.material = glass.material.clone(); // its glow's colour is set as it shimmers
  }
  // The bulb's own parts would block its light.
  bulb.traverse((o) => o.isMesh && (o.castShadow = false));

  level.root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(filament).getCenter(new THREE.Vector3());
  const light = new THREE.PointLight(0xffffff, 0, LIGHT_RANGE, 2);
  light.userData.intensity = 0;
  light.position.copy(center);
  const group = new THREE.Group();
  group.name = 'FlickeringBulb';
  group.add(light);
  level.root.parent.add(group);

  const positional = (buffer, range) => {
    const s = new THREE.PositionalAudio(listener);
    s.setDistanceModel('linear');
    s.setRefDistance(SOUND_REF);
    s.setMaxDistance(range);
    s.position.copy(center);
    if (buffer) s.setBuffer(buffer);
    group.add(s);
    return s;
  };
  const buzz = buzzBuffer ? positional(buzzBuffer, BUZZ_RANGE) : null;
  buzz?.setLoop(true).setVolume(0);
  const clink = positional(null, CLINK_RANGE);
  group.updateMatrixWorld(true);

  const rand = ([lo, hi]) => THREE.MathUtils.randFloat(lo, hi);
  // The flicker to come, as [brightness, seconds] steps.
  const steps = [];
  const plan = () => {
    steps.push([rand([0.9, 1]), rand(STEADY)]);
    const cuts = THREE.MathUtils.randInt(...BURST);
    for (let i = 0; i < cuts; i++) {
      steps.push([rand([0, 0.15]), rand(CUT)]);
      if (i < cuts - 1) steps.push([rand([0.5, 1]), rand(CATCH)]);
    }
    if (Math.random() < BLACKOUT) {
      steps.push([0, rand(BLACKOUT_LENGTH)]);
      // Sputtering back on.
      for (let i = THREE.MathUtils.randInt(1, 3); i > 0; i--) steps.push([rand([0.3, 0.8]), rand(CUT)], [rand([0, 0.1]), rand(CUT)]);
    }
  };

  let brightness = 0;
  let target = 0;
  let glassBrightness = 0;
  let timer = 0;
  let waver = 0;
  let wasOn = false;
  let lastClink = -Infinity;
  let time = 0;
  const pending = []; // clinks waiting out CLINK_DELAY: [time, volume]

  const playClink = (volume) => {
    if (!clinks.length || listener.context.state !== 'running') return;
    const source = listener.context.createBufferSource();
    source.buffer = clinks[Math.floor(Math.random() * clinks.length)];
    const gain = listener.context.createGain();
    gain.gain.value = THREE.MathUtils.clamp(volume * CLINK_VOLUME, 0, 1);
    source.connect(gain).connect(clink.getOutput());
    source.start();
  };

  return {
    meshes: glass ? [glass] : [], // see-through, so kept out of the AO
    glows,
    light,
    world,
    // `here`: the player is in this world, so the bulb can be heard.
    update(dt, here) {
      time += dt;
      timer -= dt;
      if (timer <= 0) {
        if (!steps.length) plan();
        [target, timer] = steps.shift();
      }
      // A slow random walk, only while it's burning well.
      waver = THREE.MathUtils.clamp(waver + (Math.random() - 0.5) * dt * 4, -1, 1) * 0.98;
      const goal = target > 0.85 ? target * (1 + waver * WAVER) : target;
      brightness = THREE.MathUtils.lerp(brightness, goal, 1 - Math.exp(-dt * (goal > brightness ? RISE : FALL)));
      glassBrightness = THREE.MathUtils.lerp(glassBrightness, brightness, Math.min(dt * GLASS_EASE, 1));

      for (const m of glows) m.material.emissiveIntensity = brightness * FILAMENT_GLOW;
      if (glass) glass.material.emissiveIntensity = glassBrightness * GLASS_GLOW;
      // The world switch (main.js) sets every light from userData.intensity.
      light.userData.intensity = brightness * LIGHT;
      const hue = LIGHT_HSL.h + SHIMMER * (0.6 * Math.sin(time * 0.9) + 0.4 * Math.sin(time * 2.3 + 1.7));
      light.color.setHSL((hue + 1) % 1, LIGHT_HSL.s, LIGHT_HSL.l, THREE.SRGBColorSpace);
      if (glass) glass.material.emissive.setHSL((hue + 1) % 1, 1, 0.55, THREE.SRGBColorSpace);

      if (buzz) {
        if (here && listener.context.state === 'running' && !buzz.isPlaying) buzz.play();
        else if (!here && buzz.isPlaying) buzz.pause();
        buzz.setVolume(brightness * BUZZ_VOLUME);
      }

      const on = brightness > ON;
      if (on && !wasOn && time > lastClink + CLINK_COOLDOWN) {
        pending.push(time + CLINK_DELAY);
        lastClink = time;
      }
      wasOn = on;
      while (pending.length && pending[0] <= time) {
        pending.shift();
        if (here) playClink(brightness);
      }
    },
  };
}
