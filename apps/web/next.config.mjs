/** @type {import('next').NextConfig} */
const nextConfig = {
  // Linting runs as its own turbo task (shared flat config in
  // @paymap/config); skip Next's built-in eslint-config-next pass here to
  // avoid a duplicate, differently-configured lint step during `next build`.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
