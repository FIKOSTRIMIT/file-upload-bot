import express from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import { RateLimiterMemory } from 'rate-limiter-flexible';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_PATH = process.env.SECRET_PATH || 'upload-' + Math.random().toString(36).substring(7);
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 200 * 1024 * 1024; // 200MB default (Catbox limit)

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ BOT_TOKEN and CHAT_ID must be set in .env');
  process.exit(1);
}

console.log('📦 Using Catbox.moe for file storage (200MB limit, no keys needed)');

// Rate limiter: 30 requests per minute per IP
const rateLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
});

// Storage config
const uploadDir = join(__dirname, 'uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|mkv|webm|heic|heif/;
    const ext = extname(file.originalname).toLowerCase().slice(1);
    const mime = file.mimetype;
    if (allowedTypes.test(ext) || mime.startsWith('image/') || mime.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images and videos allowed'), false);
    }
  },
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Rate limiting middleware
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).send('Too many requests. Please wait a minute.');
  }
});

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Upload page - only accessible via secret path
app.get(`/${SECRET_PATH}`, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Health check (no secret needed)
app.get('/health', (req, res) => {
  res.json({ ok: true, secretPath: SECRET_PATH, storage: 'catbox.moe', maxFileSize: '200MB' });
});

// Upload to Catbox.moe
async function uploadToCatbox(filePath, originalname, mimetype) {
  const fs = await import('fs');
  const fileStream = fs.createReadStream(filePath);
  
  const formData = new FormData();
  formData.append('reqtype', 'fileupload');
  formData.append('file', fileStream, originalname);
  
  const response = await axios.post(
    'https://catbox.moe/user/api.php',
    formData,
    { 
      headers: formData.getHeaders(),
      timeout: 300000, // 5 min for 200MB
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );
  
  // Catbox returns just the URL as plain text
  const url = response.data.trim();
  if (!url.startsWith('https://')) {
    throw new Error('Catbox upload failed: ' + url);
  }
  return url;
}

// Handle file upload (local -> Catbox -> Telegram)
app.post(`/${SECRET_PATH}/upload`, upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { path: filePath, originalname, mimetype, size } = req.file;
    const isVideo = mimetype.startsWith('video/');
    
    // Strict validation
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
    const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'];
    const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];
    
    if (!allowedTypes.includes(mimetype) && !mimetype.startsWith('image/') && !mimetype.startsWith('video/')) {
      import('fs').then(fs => fs.promises.unlink(filePath).catch(() => {}));
      return res.status(400).json({ error: 'Only photos and videos allowed' });
    }

    // Check Catbox limit (200MB)
    if (size > 200 * 1024 * 1024) {
      import('fs').then(fs => fs.promises.unlink(filePath).catch(() => {}));
      return res.status(400).json({ error: 'File too large for Catbox. Max 200MB' });
    }

    // Upload to Catbox
    console.log(`☁️  Uploading to Catbox: ${originalname} (${formatBytes(size)})`);
    const downloadUrl = await uploadToCatbox(filePath, originalname, mimetype);
    
    // Clean up local file
    import('fs').then(fs => fs.promises.unlink(filePath).catch(() => {}));

    // Send link to Telegram
    const result = await sendLinkToTelegram(originalname, size, downloadUrl, isVideo);

    console.log(`✅ Upload completed in ${Date.now() - startTime}ms: ${originalname} (${formatBytes(size)}) -> ${downloadUrl}`);

    res.json({
      success: true,
      message: 'File uploaded to Catbox, link sent to Telegram!',
      downloadUrl,
      telegram: result,
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file?.path) {
      import('fs').then(fs => fs.promises.unlink(req.file.path).catch(() => {}));
    }
    res.status(500).json({ error: error.message || 'Failed to process upload' });
  }
});

async function sendLinkToTelegram(filename, size, downloadUrl, isVideo) {
  const emoji = isVideo ? '🎬' : '🖼️';
  const caption = `${emoji} <b>${filename}</b>\n📦 ${formatBytes(size)}\n🔗 <a href="${downloadUrl}">Скачать файл (Catbox.moe)</a>\n🕐 ${new Date().toLocaleString('ru-RU')}`;
  
  const response = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    },
    { timeout: 30000 }
  );
  return response.data;
}

async function sendToTelegram(filePath, filename, mimetype, isVideo, caption) {
  const fs = await import('fs');
  const fileStream = fs.createReadStream(filePath);
  
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');

  if (isVideo) {
    formData.append('video', fileStream, filename);
  } else {
    formData.append('photo', fileStream, filename);
  }

  const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
  const timeout = isVideo ? 180000 : 120000;
  
  const response = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`,
    formData,
    { 
      headers: formData.getHeaders(), 
      timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );
  return response.data;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large. Max ${formatBytes(MAX_FILE_SIZE)}` });
    }
  }
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  File Upload Bot Server                                       ║
╠═══════════════════════════════════════════════════════════════╣
║  🌐 Server: http://localhost:${PORT}                           ║
║  🔗 Upload URL: http://your-domain.com/${SECRET_PATH}         ║
║  ❤️  Health: http://localhost:${PORT}/health                   ║
╠═══════════════════════════════════════════════════════════════╣
║  📁 Max file size: ${formatBytes(MAX_FILE_SIZE).padEnd(18)} ║
║  ☁️  Storage: Catbox.moe (200MB, no keys)             ║
║  🤖 Bot: @${BOT_TOKEN.split(':')[0].padEnd(28)} ║
║  💬 Chat ID: ${String(CHAT_ID).padEnd(28)} ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});