import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = dirname(fileURLToPath(import.meta.url))

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(configDir, 'package.json'), 'utf8'))
    return packageJson.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

function readGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: configDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

const afterimageBuild = {
  productName: 'Afterimage',
  version: readPackageVersion(),
  commit: readGitCommit(),
  timestamp: new Date().toISOString(),
}

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
  define: {
    __AFTERIMAGE_BUILD__: JSON.stringify(afterimageBuild),
  },
})
