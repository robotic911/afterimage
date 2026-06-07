import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  // Emit relative asset paths in the built index.html so Electron can
  // load it with `file://` in a packaged build. `/assets/...` absolute
  // paths would resolve to the filesystem root and 404.
  base: './',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
