import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB default

// R2 Config
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // optional: https://pub-xxx.r2.dev

const USE_R2 = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ BOT_TOKEN and CHAT_ID must be set in .env');
  process.exit(1);
}

if (USE_R2) {
  console.log('☁️  R2 storage enabled');
} else {
  console.log('⚠️  R2 not configured, falling back to local storage + Telegram direct (50MB limit)');
}

// R2 Client
let r2Client;
if (USE_R2) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

// Rate limiter: 30 requests per minute per IP
const rateLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
});

// Storage config (fallback for non-R2 or small files)
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
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

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
  res.json({ ok: true, secretPath: SECRET_PATH, r2: USE_R2 });
});

// Get presigned URL for direct browser upload to R2
app.post(`/${SECRET_PATH}/presign`, async (req, res) => {
  if (!USE_R2) {
    return res.status(400).json({ error: 'R2 not configured' });
  }

  try {
    const { filename, contentType, size } = req.body;
    
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType required' });
    }

    // Validate file type
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
    const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'];
    const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];
    
    if (!allowedTypes.includes(contentType) && !contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      return res.status(400).json({ error: 'Only photos and videos allowed' });
    }

    // Validate size
    if (size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: `File too large. Max ${formatBytes(MAX_FILE_SIZE)}` });
    }

    const key = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(filename)}`;
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 }); // 1 hour
    
    // Build public/download URL
    let downloadUrl;
    if (R2_PUBLIC_URL) {
      downloadUrl = `${R2_PUBLIC_URL}/${key}`;
    } else {
      // Generate presigned download URL (valid 7 days)
      const getCommand = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
      downloadUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 604800 });
    }

    res.json({
      uploadUrl,
      downloadUrl,
      key,
      bucket: R2_BUCKET,
    });
  } catch (error) {
    console.error('Presign error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Handle file upload (fallback: local -> Telegram direct for small files)
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

    let result;
    let downloadUrl;

    if (USE_R2) {
      // Upload to R2
      const fs = await import('fs');
      const fileStream = fs.createReadStream(filePath);
      const key = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(originalname)}`;
      
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: fileStream,
        ContentType: mimetype,
      }));

      // Clean up local file
      await fs.promises.unlink(filePath).catch(() => {});

      // Build download URL
      if (R2_PUBLIC_URL) {
        downloadUrl = `${R2_PUBLIC_URL}/${key}`;
      } else {
        const getCommand = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
        downloadUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 604800 });
      }

      // Send link to Telegram
      result = await sendLinkToTelegram(originalname, size, downloadUrl, isVideo);
    } else {
      // Fallback: direct to Telegram (50MB limit)
      const caption = `📎 ${originalname}\n📦 ${formatBytes(size)}\n🕐 ${new Date().toLocaleString('ru-RU')}`;
      result = await sendToTelegram(filePath, originalname, mimetype, isVideo, caption);
      
      import('fs').then(fs => fs.promises.unlink(filePath).catch(() => {}));
    }

    console.log(`✅ Upload completed in ${Date.now() - startTime}ms: ${originalname} (${formatBytes(size)})`);

    res.json({
      success: true,
      message: USE_R2 ? 'File uploaded to cloud, link sent to Telegram!' : 'File sent to Telegram!',
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

// Notify server that R2 upload is complete (from browser)
app.post(`/${SECRET_PATH}/complete`, async (req, res) => {
  if (!USE_R2) {
    return res.status(400).json({ error: 'R2 not configured' });
  }

  try {
    const { key, originalname, size, mimetype } = req.body;
    
    if (!key || !originalname || !size) {
      return res.status(400).json({ error: 'key, originalname, size required' });
    }

    const isVideo = mimetype?.startsWith('video/');
    
    // Build download URL
    let downloadUrl;
    if (R2_PUBLIC_URL) {
      downloadUrl = `${R2_PUBLIC_URL}/${key}`;
    } else {
      const getCommand = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
      downloadUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 604800 });
    }

    // Send link to Telegram
    const result = await sendLinkToTelegram(originalname, size, downloadUrl, isVideo);

    console.log(`✅ R2 upload completed: ${originalname} (${formatBytes(size)})`);

    res.json({
      success: true,
      message: 'File uploaded to cloud, link sent to Telegram!',
      downloadUrl,
      telegram: result,
    });
  } catch (error) {
    console.error('Complete upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to complete upload' });
  }
});

async function sendLinkToTelegram(filename, size, downloadUrl, isVideo) {
  const emoji = isVideo ? '🎬' : '🖼️';
  const caption = `${emoji} <b>${filename}</b>\n📦 ${formatBytes(size)}\n🔗 <a href="${downloadUrl}">Скачать файл</a>\n🕐 ${new Date().toLocaleString('ru-RU')}`;
  
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
  const FormData = (await import('form-data')).default;
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
  const timeout = isVideo ? 300000 : 180000;
  
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
║  ☁️  R2 Storage: ${USE_R2 ? 'ENABLED'.padEnd(24) : 'DISABLED (fallback)'.padEnd(24)} ║
║  🤖 Bot: @${BOT_TOKEN.split(':')[0].padEnd(28)} ║
║  💬 Chat ID: ${String(CHAT_ID).padEnd(28)} ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});