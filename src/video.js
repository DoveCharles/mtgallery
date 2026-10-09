import * as THREE from 'three';
import videoUrl from '../media/vid.mp4?url';

// The video wall (the "Vid" plane, room 5555 right), as the Unity scene had it: media/vid.mp4
// on a loop, muted. It only plays while the player is in its world.

export function addVideoScreen(level, world) {
  const plane = level.root.getObjectByName('Vid');
  if (!plane?.isMesh) return null;

  const video = document.createElement('video');
  video.src = videoUrl;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // glTF UVs
  plane.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
  plane.castShadow = false;

  let starting = false;
  return {
    meshes: [plane],
    world,
    // `here`: the player is in this world.
    update(dt, here) {
      if (here && video.paused && !starting) {
        starting = true;
        video.play().catch(() => {}).finally(() => (starting = false));
      } else if (!here && !video.paused) video.pause();
    },
  };
}
