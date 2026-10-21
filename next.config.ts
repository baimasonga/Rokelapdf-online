import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.ROKELA_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['pg'],
};

export default nextConfig;
