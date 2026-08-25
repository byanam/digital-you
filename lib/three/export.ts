'use client';

/**
 * Export the finished avatar.
 *
 * GLB goes through GLTFExporter so the skeleton, skin weights and baked texture
 * survive — that is the format a garment simulation or a game engine will want.
 * OBJ is written by hand: three's OBJExporter ignores world transforms on nested
 * meshes and emits no texture coordinates for indexed geometry it doesn't
 * recognise, and OBJ cannot carry a rig anyway, so a small purpose-built writer
 * is both shorter and more predictable.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export async function exportGlb(root: THREE.Object3D): Promise<Blob> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, {
    binary: true,
    onlyVisible: true,
    // Keep the bind pose: the mesh *is* the measurement, so an animation-time
    // pose would silently change the exported proportions.
    animations: [],
    includeCustomExtensions: false,
  });
  if (result instanceof ArrayBuffer) {
    return new Blob([result], { type: 'model/gltf-binary' });
  }
  return new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });
}

export function exportObj(root: THREE.Object3D): Blob {
  root.updateMatrixWorld(true);

  const lines: string[] = [
    '# Digital You — photogrammetric body reconstruction',
    '# Units: metres. +Y up, y=0 at the sole, +Z is the facing direction.',
    '',
  ];

  let vOffset = 0;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let meshIndex = 0;

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');

    lines.push(`o ${mesh.name || `mesh_${meshIndex}`}`);
    meshIndex++;

    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(
        mesh.matrixWorld,
      );
      lines.push(`v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}`);
    }
    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        lines.push(
          `vt ${(uv as THREE.BufferAttribute).getX(i).toFixed(5)} ${(uv as THREE.BufferAttribute)
            .getY(i)
            .toFixed(5)}`,
        );
      }
    }
    if (normal) {
      for (let i = 0; i < normal.count; i++) {
        n.fromBufferAttribute(normal as THREE.BufferAttribute, i)
          .applyMatrix3(normalMatrix)
          .normalize();
        lines.push(`vn ${n.x.toFixed(5)} ${n.y.toFixed(5)} ${n.z.toFixed(5)}`);
      }
    }

    const face = (a: number, b: number, c: number) => {
      const ref = (i: number) => {
        const k = i + 1 + vOffset;
        if (uv && normal) return `${k}/${k}/${k}`;
        if (uv) return `${k}/${k}`;
        if (normal) return `${k}//${k}`;
        return `${k}`;
      };
      lines.push(`f ${ref(a)} ${ref(b)} ${ref(c)}`);
    };

    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        face(index.getX(i), index.getX(i + 1), index.getX(i + 2));
      }
    } else {
      for (let i = 0; i < position.count; i += 3) face(i, i + 1, i + 2);
    }

    vOffset += position.count;
    lines.push('');
  });

  return new Blob([lines.join('\n')], { type: 'model/obj' });
}

/** The baked atlas as a PNG, so an OBJ export can still be textured by hand. */
export function exportTexture(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the texture atlas'));
    }, 'image/png');
  });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next macrotask; revoking synchronously cancels the download
  // in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
