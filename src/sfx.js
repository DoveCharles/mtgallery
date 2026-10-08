import * as THREE from 'three';

// The starting area's sounds, from the Unity project's Audio folder (the long WAVs
// re-encoded to AAC): the drop, the corridor drone, the keypad's clicks and verdicts and
// the doors. One-shots play flat, or from an object when one is given (the doors).
// Sounds still loading when they are due are skipped, as are any before the first click
// has started the audio context.

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
const DRONE_VOLUME = 0.166; // as on the Unity AudioSource
const DRONE_FADE = 1.5; // seconds, in and out
const DOOR_REF_DISTANCE = 3;

export class Sfx {
  buffers = {};
  drone = null;
  droneOn = false;

  constructor(listener) {
    this.listener = listener;
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

  play(name, { at, volume = 1 } = {}) {
    const buffer = this.buffers[name];
    if (!buffer || !this.ready) return;
    const sound = at ? new THREE.PositionalAudio(this.listener) : new THREE.Audio(this.listener);
    sound.setBuffer(buffer).setVolume(volume);
    if (at) {
      sound.setRefDistance(DOOR_REF_DISTANCE);
      at.add(sound);
    }
    sound.onEnded = () => {
      sound.isPlaying = false;
      sound.removeFromParent();
      sound.disconnect();
    };
    sound.play();
  }

  click() {
    this.play(CLICKS[Math.floor(Math.random() * CLICKS.length)]);
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
