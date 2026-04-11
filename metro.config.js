// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * We want Metro to treat .html/.xml and our large vendor .bundle files as
 * static assets (not transformable JS). This allows <script src="..."> in
 * our WebView HTML to load them locally on Android/iOS.
 */
const fs = require('fs');
const path = require('path');

config.resolver.assetExts = [...config.resolver.assetExts, 'html','xml','bundle','css'];

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    return (req, res, next) => {
      let urlPath = req.url.split('?')[0];
      
      let filePath = null;
      if (urlPath.startsWith('/vendor/')) {
        filePath = path.join(__dirname, 'assets', 'vendor', urlPath.replace('/vendor/', ''));
      } else if (urlPath.startsWith('/assets/')) {
        filePath = path.join(__dirname, 'assets', 'blockly', urlPath.replace('/assets/', ''));
      }

      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        if (ext === '.bundle' || ext === '.js') {
          res.setHeader('Content-Type', 'application/javascript');
        } else if (ext === '.css') {
          res.setHeader('Content-Type', 'text/css');
        } else if (ext === '.woff2') {
          res.setHeader('Content-Type', 'font/woff2');
        } else if (ext === '.woff' || ext === '.ttf') {
          res.setHeader('Content-Type', 'font/' + ext.replace('.', ''));
        } else if (ext === '.png') {
          res.setHeader('Content-Type', 'image/png');
        } else if (ext === '.svg') {
          res.setHeader('Content-Type', 'image/svg+xml');
        } else if (ext === '.mp3') {
          res.setHeader('Content-Type', 'audio/mpeg');
        } else if (ext === '.wav') {
          res.setHeader('Content-Type', 'audio/wav');
        }
        res.end(fs.readFileSync(filePath));
        return;
      }
      
      return middleware(req, res, next);
    };
  }
};

module.exports = config;
