import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
	reactStrictMode: true,
	turbopack: {
		root: resolve(__dirname, ".."),
	},
};

export default withMDX(config);
