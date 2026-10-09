import * as THREE from 'three';
import videoUrl from '../media/vid.mp4?url';

// The video wall (the "Vid" plane, room 5555 right), as the Unity scene had it: media/vid.mp4
// on a loop, with its sound coming from the wall. It only plays while the player is in its
// world (browsers hold back sound until the first click or key, see main.js).

const SOUND_REF = 5; // m: full volume within this
const VOLUME = 1;

export function addVideoScreen(level, listener, world) {
  const plane = level.root.getObjectByName('Vid');
  if (!plane?.isMesh) return null;

  const video = document.createElement('video');
  video.src = videoUrl;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // glTF UVs
  plane.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
  plane.castShadow = false;

  level.root.updateMatrixWorld(true);
  const sound = new THREE.PositionalAudio(listener);
  sound.setMediaElementSource(video);
  sound.setRefDistance(SOUND_REF);
  sound.setVolume(VOLUME);
  new THREE.Box3().setFromObject(plane).getCenter(sound.position);
  level.root.parent.add(sound);

  let starting = false;
  return {
    meshes: [plane],
    world,
    // `here`: the player is in this world.
    update(dt, here) {
      if (here && video.paused && !starting && listener.context.state === 'running') {
        starting = true;
        video.play().catch(() => {}).finally(() => (starting = false));
      } else if (!here && !video.paused) video.pause();
    },
  };
}
