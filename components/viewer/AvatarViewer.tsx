'use client';

/**
 * The WebGL viewport.
 *
 * Lighting is a three-point studio rig plus a procedural room environment, which
 * matters more than it sounds: skin without an environment map reads as vinyl,
 * and the rim light is what separates the silhouette from a near-black
 * background. The environment is generated at runtime by RoomEnvironment, so
 * there is no HDR asset to ship or fetch.
 *
 * Camera presets are tweened in the render loop rather than snapped, because the
 * user's mental model of "which side am I looking at" survives a 700 ms move and
 * does not survive a cut.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AvatarObject } from '@/lib/three/avatar';

export type ViewPreset = 'front' | 'side' | 'back' | 'head';

export interface AvatarViewerProps {
  avatar: AvatarObject;
  wireframe: boolean;
  preset: ViewPreset;
  /** Increment to re-apply the current preset (e.g. a "recentre" tap). */
  presetNonce: number;
  onInteract?: () => void;
  className?: string;
}

interface PresetPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * Preset camera poses in units of stature.
 * +Z is the facing direction, +X is the avatar's own left, so a camera on -X
 * sees the avatar's right side with the face pointing to screen-right — the
 * conventional profile framing.
 */
function poseFor(preset: ViewPreset, h: number): PresetPose {
  switch (preset) {
    case 'side':
      return {
        position: new THREE.Vector3(-1.95 * h, 0.56 * h, 0.02 * h),
        target: new THREE.Vector3(0, 0.5 * h, 0),
      };
    case 'back':
      return {
        position: new THREE.Vector3(0.02 * h, 0.56 * h, -1.95 * h),
        target: new THREE.Vector3(0, 0.5 * h, 0),
      };
    case 'head':
      return {
        position: new THREE.Vector3(0.06 * h, 0.95 * h, 0.62 * h),
        target: new THREE.Vector3(0, 0.905 * h, 0),
      };
    case 'front':
    default:
      return {
        position: new THREE.Vector3(0, 0.56 * h, 1.95 * h),
        target: new THREE.Vector3(0, 0.5 * h, 0),
      };
  }
}

export function AvatarViewer({
  avatar,
  wireframe,
  preset,
  presetNonce,
  onInteract,
  className = '',
}: AvatarViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const avatarSlotRef = useRef<THREE.Group | null>(null);
  const tweenRef = useRef<{
    from: PresetPose;
    to: PresetPose;
    t: number;
    active: boolean;
  } | null>(null);
  const interactedRef = useRef(false);
  const snapRef = useRef(true);
  const onInteractRef = useRef(onInteract);
  onInteractRef.current = onInteract;

  // ── one-time scene construction ─────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Procedural studio environment — no HDR asset required.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    scene.environment = envRT.texture;
    // The room only exists to be pre-filtered; release its buffers immediately.
    room.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of mats) material?.dispose();
    });

    const camera = new THREE.PerspectiveCamera(
      32,
      (host.clientWidth || 1) / (host.clientHeight || 1),
      0.02,
      60,
    );
    camera.position.set(0, 1, 3.4);
    cameraRef.current = camera;

    // ── three-point studio rig ───────────────────────────────────────────
    const key = new THREE.DirectionalLight(0xfff4e8, 2.5);
    key.position.set(1.9, 3.1, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -1.6;
    key.shadow.camera.right = 1.6;
    key.shadow.camera.top = 2.6;
    key.shadow.camera.bottom = -0.4;
    // A small bias band: the body is a closed smooth surface, so shadow acne
    // shows up as banding across the chest without it.
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xdce7ff, 0.85);
    fill.position.set(-2.6, 1.5, 1.6);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xbcd4ff, 2.1);
    rim.position.set(-0.9, 2.4, -3.1);
    scene.add(rim);

    const bounce = new THREE.HemisphereLight(0x9fb4d8, 0x0b0b0e, 0.5);
    scene.add(bounce);

    // ── shadow catcher ───────────────────────────────────────────────────
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.ShadowMaterial({ opacity: 0.42, color: 0x000000 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    // A faint grid gives the eye a ground plane without lighting one.
    const grid = new THREE.GridHelper(8, 32, 0x2a2a33, 0x17171b);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.32;
    grid.position.y = 0.001;
    scene.add(grid);

    const slot = new THREE.Group();
    scene.add(slot);
    avatarSlotRef.current = slot;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.7;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.28;
    controls.maxDistance = 9;
    // Stop just short of the poles so the model never flips or clips the floor.
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI * 0.94;
    controls.autoRotate = true;
    controls.autoRotateSpeed = -0.55;
    controls.target.set(0, 0.9, 0);
    controlsRef.current = controls;

    const onStart = () => {
      controls.autoRotate = false;
      tweenRef.current = null;
      if (!interactedRef.current) {
        interactedRef.current = true;
        onInteractRef.current?.();
      }
    };
    controls.addEventListener('start', onStart);

    // ── sizing ───────────────────────────────────────────────────────────
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // ── render loop ──────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(0.05, clock.getDelta());
      const tween = tweenRef.current;
      if (tween?.active) {
        tween.t = Math.min(1, tween.t + dt / 0.7);
        // Quintic ease-out: fast commitment, soft arrival.
        const e = 1 - Math.pow(1 - tween.t, 5);
        camera.position.lerpVectors(tween.from.position, tween.to.position, e);
        controls.target.lerpVectors(tween.from.target, tween.to.target, e);
        if (tween.t >= 1) tween.active = false;
      }
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.removeEventListener('start', onStart);
      controls.dispose();
      envRT.texture.dispose();
      pmrem.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      sceneRef.current = null;
      avatarSlotRef.current = null;
    };
  }, []);

  // ── mount / swap the avatar ─────────────────────────────────────────────
  useEffect(() => {
    const slot = avatarSlotRef.current;
    const controls = controlsRef.current;
    if (!slot || !controls) return;

    slot.clear();
    slot.add(avatar.root);

    const h = avatar.height || 1.7;
    controls.minDistance = 0.22 * h;
    controls.maxDistance = 6 * h;

    // The preset effect below runs immediately after this one and does the
    // framing; `snap` tells it to cut rather than fly, since there is no
    // previous view to fly from.
    snapRef.current = true;
    tweenRef.current = null;
    interactedRef.current = false;

    return () => {
      slot.remove(avatar.root);
    };
  }, [avatar]);

  // ── presets ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    const pose = poseFor(preset, avatar.height || 1.7);

    if (snapRef.current) {
      snapRef.current = false;
      camera.position.copy(pose.position);
      controls.target.copy(pose.target);
      controls.update();
      // A slow turntable on arrival; the first drag stops it for good.
      controls.autoRotate = true;
      return;
    }

    controls.autoRotate = false;
    tweenRef.current = {
      from: { position: camera.position.clone(), target: controls.target.clone() },
      to: pose,
      t: 0,
      active: true,
    };
  }, [avatar, preset, presetNonce]);

  // ── wireframe ───────────────────────────────────────────────────────────
  useEffect(() => {
    const root = avatar.root;
    const wire = new THREE.MeshBasicMaterial({
      color: 0x8ab4ff,
      wireframe: true,
      transparent: true,
      opacity: 0.72,
    });
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      originals.set(mesh, mesh.material);
      if (wireframe) {
        mesh.material = wire;
        mesh.castShadow = false;
      } else {
        mesh.castShadow = true;
      }
    });

    return () => {
      for (const [mesh, material] of originals) {
        mesh.material = material;
        mesh.castShadow = true;
      }
      wire.dispose();
    };
  }, [wireframe, avatar]);

  return (
    <div
      ref={hostRef}
      className={`relative h-full w-full ${className}`}
      // OrbitControls needs the gestures; the page must not scroll under them.
      style={{ touchAction: 'none' }}
    />
  );
}
