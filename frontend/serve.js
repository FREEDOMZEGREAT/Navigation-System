
const http = require('http');
const fs = require('fs');
const path = require('path');
const { default: open } = require('open');

const root = path.join(__dirname);
const port = process.env.PORT || 8080;

const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function sendFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const type = mime[ext] || 'application/octet-stream';
  fs.createReadStream(filePath)
    .on('error', () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    })
    .once('open', () => {
      res.writeHead(200, { 'Content-Type': type });
    })
    .pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    const safePath = decodeURI(req.url.split('?')[0]);
    let filePath = path.join(root, safePath);

    // If request is root or looks like a directory, serve index.html (SPA fallback)
    if (safePath === '/' || safePath === '' || safePath.endsWith('/')) {
      filePath = path.join(root, 'index.html');
    }

    // Prevent path traversal
    if (!filePath.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // If no file, fall back to index.html (useful for SPA routes)
        const indexPath = path.join(root, 'index.html');
        fs.stat(indexPath, (ie, is) => {
          if (!ie && is.isFile()) return sendFile(indexPath, res);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        });
        return;
      }
      sendFile(filePath, res);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(port, () => {
  console.log(`Frontend static server running at http://localhost:${port}`);
  console.log('Serving from', root);
  
  // Automatically open browser
  console.log(`🌐 Opening browser at http://localhost:${port}`);
  open(`http://localhost:${port}`).catch(err => {
    console.warn('Could not open browser automatically:', err.message);
  });
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\nShutting down'); process.exit(0); });
