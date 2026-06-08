/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP route is request/response only, so there is nothing to statically prerender.
  reactStrictMode: true,
};

export default nextConfig;
