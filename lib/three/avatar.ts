'use client';

/**
 * Three.js assembly: rigged geometry + baked atlas → a skinned, exportable
 * avatar; plus loaders for the two external mesh sources (a neural provider's
 * .glb, or an optional licensed base human dropped into public/models).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BakeResult } from '../body/bake';
import type { RiggedGeometry } from '../body/rigging';

export interface AvatarObject {
  /** Add this to the scene; also the object to hand to GLTFExporter. */
  root: THREE.Group;
  mesh: THREE.SkinnedMesh | THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  skeleton: THREE.Skeleton | null;
  texture: THREE.Texture | null;
  triangles: number;
  vertices: number;
  /** World-space height of the model, metres. */
  height: number;
}

function skinMaterial(bake: BakeResult | null): THREE.MeshStandardMaterial {
  const skin = bake?.skin ?? [189, 151, 128];
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(
      skin[0] / 255,
      skin[1] / 255,
      skin[2] / 255,
      THREE.SRGBColorSpace,
    ),
    // Skin is dielectric and fairly rough; a hint of specular breakup keeps the
    // studio rim light from reading as plastic.
    roughness: 0.62,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  if (bake) {
    const tex = new THREE.CanvasTexture(bake.canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    mat.map = tex;
    mat.color.set(0xffffff);
  }
  return mat;
}

export function buildAvatarObject(
  geo: RiggedGeometry,
  bake: BakeResult | null,
): AvatarObject {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(geo.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(geo.skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(geo.skinWeights, 4));
  geometry.setIndex(new THREE.BufferAttribute(geo.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = skinMaterial(bake);

  // Bones are authored with world-aligned axes and pure translations. That is
  // unusual for a hand-rigged character but perfectly valid, and it keeps the
  // bind pose exactly equal to the mesh we just generated.
  const bones: THREE.Bone[] = [];
  for (const def of geo.bones) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    const parent = def.parent >= 0 ? geo.bones[def.parent] : null;
    bone.position.set(
      def.world[0] - (parent ? parent.world[0] : 0),
      def.world[1] - (parent ? parent.world[1] : 0),
      def.world[2] - (parent ? parent.world[2] : 0),
    );
    bones.push(bone);
  }
  geo.bones.forEach((def, i) => {
    if (def.parent >= 0) bones[def.parent].add(bones[i]);
  });

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'DigitalYou';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.add(bones[0]);
  bones[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);

  const root = new THREE.Group();
  root.name = 'DigitalYouRoot';
  root.add(mesh);

  const bb = geometry.boundingBox;
  return {
    root,
    mesh,
    material,
    skeleton,
    texture: material.map,
    triangles: geo.indices.length / 3,
    vertices: geo.positions.length / 3,
    height: bb ? bb.max.y - bb.min.y : 1.7,
  };
}

// ─────────────────────────────────────────────────────────── external meshes ──

export interface LoadedGltf {
  root: THREE.Group;
  meshes: THREE.Mesh[];
  triangles: number;
  vertices: number;
  height: number;
}

export async function loadGltf(url: string): Promise<LoadedGltf> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.add(gltf.scene);

  const meshes: THREE.Mesh[] = [];
  let triangles = 0;
  let vertices = 0;
  gltf.scene.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    meshes.push(m);
    m.castShadow = true;
    m.receiveShadow = true;
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    vertices += pos ? pos.count : 0;
    triangles += g.index ? g.index.count / 3 : pos ? pos.count / 3 : 0;
  });

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const height = Math.max(0.1, box.max.y - box.min.y);
  return { root, meshes, triangles, vertices, height };
}

/**
 * Normalise an arbitrary provider mesh: centre it on the origin, stand it on
 * y = 0 and scale it to the measured stature. Neural providers return meshes in
 * unpredictable units and orientations, so this is what makes the viewer's
 * camera presets and the metre-based telemetry line up.
 */
export function normalizeToStature(
  root: THREE.Object3D,
  statureM: number,
): { scale: number; height: number } {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!(size.y > 1e-4)) return { scale: 1, height: statureM };
  const scale = statureM / size.y;
  root.scale.multiplyScalar(scale);

  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  const centre = new THREE.Vector3();
  box2.getCenter(centre);
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box2.min.y;
  return { scale, height: statureM };
}
