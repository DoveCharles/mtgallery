import * as THREE from 'three';

// The flickering lightbulb (the "Lightbulb" object, with its "Filament" child), ported from
// the old Unity RealisticFlickerEmissionLightAndGlass with the values it had in the scene.
// Every MIN_DELAY–MAX_DELAY seconds the bulb picks a new brightness (or, BLACKOUT of the
// time, goes dark), and eases towards it; the glass follows more slowly. The brightness
// drives the filament's glow, the glass's, a point light and the buzz's volume, and every
// time the bulb comes back on (crosses ON) it clinks.

const MIN_DELAY = 0.01; // s
const MAX_DELAY = 0.51;
const BLACKOUT = 0.1; // chance of a pick being "off"
const EASE = 12; // per second, towards the picked brightness
const GLASS_EASE = 6;

const FILAMENT_COLOR = new THREE.Color(1, 0.5913, 0.1569);
const FILAMENT_GLOW = 220; // emissive strength at full (as exported from Blender)
const GLASS_COLOR = new THREE.Color(1, 0.4132, 0);
const GLASS_GLOW = 0.4; // emissive intensity at full
const LIGHT_COLOR = new THREE.Color(1, 0.6264, 0.1686);
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
    glass.material = glass.material.clone();
    glass.material.emissive.copy(GLASS_COLOR);
  }
  // The bulb's own parts would block its light.
  bulb.traverse((o) => o.isMesh && (o.castShadow = false));

  level.root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(filament).getCenter(new THREE.Vector3());
  const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_RANGE, 2);
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

  let brightness = 0;
  let target = 0;
  let glassBrightness = 0;
  let timer = 0;
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
        target = Math.random() < BLACKOUT ? 0 : Math.random();
        timer = THREE.MathUtils.randFloat(MIN_DELAY, MAX_DELAY);
      }
      brightness = THREE.MathUtils.lerp(brightness, target, Math.min(dt * EASE, 1));
      glassBrightness = THREE.MathUtils.lerp(glassBrightness, brightness, Math.min(dt * GLASS_EASE, 1));

      for (const m of glows) m.material.emissiveIntensity = brightness * FILAMENT_GLOW;
      if (glass) glass.material.emissiveIntensity = glassBrightness * GLASS_GLOW;
      // The world switch (main.js) sets every light from userData.intensity.
      light.userData.intensity = brightness * LIGHT;

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
