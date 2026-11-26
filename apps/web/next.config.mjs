import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lets automated browser tests run an isolated dev server without touching the developer's .next directory.
  distDir: process.env.CLAM_NEXT_DIST_DIR || '.next',
  transpilePackages: ['@clam/shared'],
};

export default nextConfig;
