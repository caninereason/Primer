import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  base: '/Primer/',
  plugins: [
    react(),
    {
      name: 'save-chord-plugin',
      configureServer(server) {
        const customChordsPath = () => path.resolve(process.cwd(), 'src', 'customChords.json');
        server.middlewares.use('/api/custom-chords', (req: any, res: any) => {
          if (req.method === 'GET') {
            try {
              const filePath = customChordsPath();
              if (!fs.existsSync(filePath)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({}));
                return;
              }
              const content = fs.readFileSync(filePath, 'utf-8');
              const data = content.trim() ? JSON.parse(content) : {};
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          } else {
            res.statusCode = 405;
            res.end();
          }
        });
        server.middlewares.use('/api/save-chord', (req: any, res: any) => {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: any) => {
              body += chunk.toString();
            });
            req.on('end', () => {
              try {
                const { symbol, positionIdx, tab } = JSON.parse(body);
                if (typeof symbol !== 'string' || typeof positionIdx !== 'number' || positionIdx < 0 || positionIdx > 4) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: 'Invalid symbol or positionIdx' }));
                  return;
                }
                const normalizedTab = Array.isArray(tab) && tab.length === 6
                  ? tab.map((f: unknown) => (typeof f === 'number' && !Number.isNaN(f) && f >= 0) || f === null ? f : null)
                  : null;
                if (!normalizedTab) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: 'Invalid tab (need 6 elements)' }));
                  return;
                }
                const filePath = customChordsPath();
                let customChords: Record<string, (number | null)[][]> = {};
                if (fs.existsSync(filePath)) {
                  const content = fs.readFileSync(filePath, 'utf-8');
                  if (content.trim()) {
                    customChords = JSON.parse(content);
                  }
                }
                if (!Array.isArray(customChords[symbol])) {
                  customChords[symbol] = [];
                }
                const arr = customChords[symbol];
                while (arr.length <= positionIdx) arr.push([null, null, null, null, null, null]);
                arr[positionIdx] = normalizedTab;
                fs.writeFileSync(filePath, JSON.stringify(customChords, null, 2));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, customChords }));
              } catch (e: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: e.message }));
              }
            });
          } else {
            res.statusCode = 405;
            res.end();
          }
        });
      }
    }
  ],
})
