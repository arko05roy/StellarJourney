import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Contract deployment records are read at request time. Trace them into
  // Vercel's serverless functions even though they live outside apps/web.
  outputFileTracingRoot: path.join(appDirectory, "../.."),
  outputFileTracingIncludes: {
    "/*": ["../../deployments/*.json"],
  },
  // Linting runs as its own turbo task (shared flat config in
  // @paymap/config); skip Next's built-in eslint-config-next pass here to
  // avoid a duplicate, differently-configured lint step during `next build`.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
