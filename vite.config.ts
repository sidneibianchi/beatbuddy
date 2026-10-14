import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

// Automatically resolves case-sensitivity differences between Windows/Mac and Linux (e.g. MasterToolbar vs masterToolbar)
function caseInsensitiveResolver() {
  return {
    name: 'case-insensitive-resolver',
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith('.')) return null;
      try {
        const dir = path.dirname(importer);
        const resolvedBase = path.resolve(dir, source);
        const extensions = ['', '.tsx', '.ts', '.jsx', '.js', '.json'];
        
        // If exact file already exists on disk, continue normal resolution
        for (const ext of extensions) {
          if (fs.existsSync(resolvedBase + ext)) return null;
        }

        // Look for case-insensitive match in directory
        const targetDir = path.dirname(resolvedBase);
        if (!fs.existsSync(targetDir)) return null;
        const targetBaseName = path.basename(resolvedBase).toLowerCase();
        
        const files = fs.readdirSync(targetDir);
        for (const file of files) {
          const fileNoExt = file.replace(/\.[^/.]+$/, '').toLowerCase();
          if (fileNoExt === targetBaseName || file.toLowerCase() === targetBaseName) {
            return path.resolve(targetDir, file);
          }
        }
      } catch {}
      return null;
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [caseInsensitiveResolver(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
