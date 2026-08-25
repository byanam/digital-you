# Where a licensed base human mesh goes

Drop a rigged, textured humanoid GLB here as `base-human.glb` and the local
pipeline will deform **that** mesh to your measurements instead of synthesising
its own body from the signed distance field.

    public/models/base-human.glb

It is auto-detected at runtime — no env var, no rebuild. If the file is absent
the app synthesises the body itself, which is the default path and needs
nothing.

Requirements:

* glTF binary (`.glb`), single skinned mesh preferred.
* A-pose or T-pose, standing, feet at the origin, facing +Z.
* Real-world scale is not required; the loader normalises stature.

Suitable sources include SMPL / SMPL-X body exports, MakeHuman exports, and
commercial base meshes. Check the licence before shipping one — none is
included here.
