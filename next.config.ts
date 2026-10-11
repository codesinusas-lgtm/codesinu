import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ['192.168.0.120'],
  distDir: process.env.NODE_ENV === 'development' ? 'dev-build' : '.next',
};
export default nextConfig;
