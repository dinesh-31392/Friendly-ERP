import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Honour a harness-assigned port. Vite ignores $PORT by default, so read it
// here — with autoPort in .claude/launch.json the launcher picks a free port
// and passes it via PORT, which lets this dev server coexist with another
// chat's server already holding 5173. Falls back to 5173 for a plain `npm run dev`.
const devPort = process.env.PORT ? Number(process.env.PORT) : 5173;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: { port: devPort },
  preview: { port: process.env.PORT ? Number(process.env.PORT) : 4173 },
});
