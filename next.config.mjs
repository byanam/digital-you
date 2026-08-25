/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three.js ships untranspiled ESM in examples/jsm — Next handles this natively,
  // but transpilePackages keeps older bundler setups happy too.
  transpilePackages: ['three'],
  // No body-size override here on purpose. Photos go to a Route Handler
  // (app/api/reconstruct), not a Server Action, so `serverActions.bodySizeLimit`
  // would not govern them. Route Handlers stream the request body and Next
  // imposes no limit of its own; client-side compression to 1024 px / q0.85 keeps
  // a two-photo payload around 400-800 KB, which is inside the ~4.5 MB ceiling
  // that serverless hosts such as Vercel apply at the edge.
  webpack: (config) => {
    // Allow importing .glsl-ish assets as raw strings if you add any later.
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      type: 'asset/source',
    });
    return config;
  },
};

export default nextConfig;
