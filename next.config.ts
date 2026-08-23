import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // The bag room board is a single static file in public/. Serve it at a
      // clean /board so the link handed to the team has no .html on the end.
      { source: "/board", destination: "/board.html" },
      { source: "/aus/bagroom", destination: "/board.html" },
    ];
  },
  async headers() {
    return [
      {
        // The board may be embedded on a TV kiosk or another host.
        source: "/board.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
