import express from 'express';
import multer from 'multer';
import axios from 'axios';
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
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB default

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ BOT_TOKEN and CHAT_ID must be set in .env');
  process.exit(1);
}

// Rate limiter: 10 requests per minute per IP
const rateLimiter = new RateLimiterMemory({
  points: 10,
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
  contentSecurityPolicy: false, // We'll handle CSP manually for inline scripts
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  res.json({ ok: true, secretPath: SECRET_PATH });
});

// Handle file upload
app.post(`/${SECRET_PATH}/upload`, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { path: filePath, originalname, mimetype, size } = req.file;
    const isVideo = mimetype.startsWith('video/');
    const caption = `📎 ${originalname}\n📦 ${formatBytes(size)}\n🕐 ${new Date().toLocaleString('ru-RU')}`;

    // Send to Telegram
    const result = await sendToTelegram(filePath, originalname, mimetype, isVideo, caption);

    // Clean up local file after sending
    import('fs').then(fs => fs.promises.unlink(filePath).catch(() => {}));

    res.json({
      success: true,
      message: 'File sent to Telegram!',
      telegram: result,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to send to Telegram' });
  }
});

async function sendToTelegram(filePath, filename, mimetype, isVideo, caption) {
  const FormData = (await import('form-data')).default;
  const fs = await import('fs');
  const fileBuffer = await fs.promises.readFile(filePath);
  
  const formData = new FormData();
  
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');

  if (isVideo) {
    formData.append('video', fileBuffer, filename);
  } else {
    formData.append('photo', fileBuffer, filename);
  }

  const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
  const timeout = isVideo ? 120000 : 60000;
  
  const response = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`,
    formData,
    { headers: formData.getHeaders(), timeout }
  );
  return response.data;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
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
╔══════════════════════════════════════════════════════════════╗
║  File Upload Bot Server                                       ║
╠══════════════════════════════════════════════════════════════╣
║  🌐 Server: http://localhost:${PORT}                           ║
║  🔗 Upload URL: http://your-domain.com/${SECRET_PATH}         ║
║  ❤️  Health: http://localhost:${PORT}/health                   ║
╠══════════════════════════════════════════════════════════════╣
║  📁 Max file size: ${formatBytes(MAX_FILE_SIZE)}                         ║
║  🤖 Bot: @${BOT_TOKEN.split(':')[0]}                            ║
║  💬 Chat ID: ${CHAT_ID}                                       ║
╚══════════════════════════════════════════════════════════════╝
  `);
});