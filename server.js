import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();

// Global request logger to debug 413 errors
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`[REQUEST] ${req.method} ${req.url} - Content-Length: ${req.headers['content-length']} bytes`);
  }
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 250 * 1024 * 1024 } // Keep 250MB on server just in case
});
const PORT = process.env.PORT || 3000;

// Only apply body parsers where needed or with high limits
app.use(express.json({ limit: '250MB' }));
app.use(express.urlencoded({ limit: '250MB', extended: true }));
app.use(express.static('public'));

const jobs = new Map();
const chunkedUploads = new Map();

// Helper to sanitize Cloudinary public_id
function getPublicId(url) {
  const filename = path.basename(url, path.extname(url));
  return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Helper to get Cloudinary error message
function cloudinaryErrMsg(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  
  let msg = '';
  if (err.error?.message) msg = err.error.message;
  else if (err.message) msg = err.message;
  else msg = JSON.stringify(err);

  if (err.http_code) msg += ` (HTTP ${err.http_code})`;
  if (err.name && err.name !== 'Error') msg = `[${err.name}] ${msg}`;
  
  return msg;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    envCreds: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  });
});

// Chunked Upload Endpoint
app.post('/api/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, fileName } = req.body;
  
  if (!uploadId || !req.file) {
    return res.status(400).json({ error: 'Missing uploadId or chunk file' });
  }

  const uploadDir = path.join('./uploads', uploadId);
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
  fs.renameSync(req.file.path, chunkPath);

  res.json({ success: true, chunkIndex });
});

// Process Chunked Upload
app.post('/api/process-chunked', async (req, res) => {
  const { uploadId, totalChunks, fileName, effect } = req.body;
  
  if (!uploadId || !totalChunks) {
    return res.status(400).json({ error: 'Missing uploadId or totalChunks' });
  }

  const uploadDir = path.join('./uploads', uploadId);
  const finalPath = path.join('./uploads', `${Date.now()}-${fileName}`);
  
  try {
    const writeStream = fs.createWriteStream(finalPath);
    
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(uploadDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Chunk ${i} missing`);
      }
      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
      fs.unlinkSync(chunkPath); // Delete chunk after merging
    }
    
    writeStream.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Clean up upload directory
    fs.rmSync(uploadDir, { recursive: true, force: true });

    // Now trigger the existing processing logic
    // We'll refactor the process logic into a reusable function
    const jobId = await startProcessing(finalPath, fileName, effect);
    res.json({ jobId });

  } catch (err) {
    console.error('[Chunk Merge Error]', err);
    res.status(500).json({ error: 'Failed to reassemble file: ' + err.message });
  }
});

async function startProcessing(filePath, originalName, effect) {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER;

  const jobId = uuidv4();
  const job = {
    status: 'processing',
    stats: { total: 0, success: 0, failed: 0 },
    logs: [],
    resultPath: path.join('./uploads', `result-${jobId}.csv`)
  };
  jobs.set(jobId, job);

  // Background processing
  (async () => {
    try {
      cloudinary.config({ cloud_name, api_key, api_secret });
      const folderPath = folder || 'eduhub/questions';
      const imageEffect = effect;

      const htmlFields = [
        'question_hin', 'question_eng',
        'option1_hin', 'option2_hin', 'option3_hin', 'option4_hin', 'option5_hin',
        'option1_eng', 'option2_eng', 'option3_eng', 'option4_eng', 'option5_eng',
        'solution_hin', 'solution_eng'
      ];

      // PASS 1: Extract unique URLs
      job.logs.push('Pass 1: Analyzing dataset for images...');
      const urlSet = new Set();
      
      const parser1 = fs.createReadStream(filePath).pipe(parse({ 
        columns: true, 
        skip_empty_lines: true, 
        relax_quotes: true,
        trim: true 
      }));

      for await (const record of parser1) {
        htmlFields.forEach(field => {
          if (record[field]) {
            const matches = record[field].match(/<img[^>]+src=["']([^"']+)["']/gi);
            if (matches) {
              matches.forEach(m => {
                const src = m.match(/src=["']([^"']+)["']/)[1];
                urlSet.add(src);
              });
            }
          }
        });
      }

      const uniqueUrls = Array.from(urlSet);
      job.stats.total = uniqueUrls.length;
      job.logs.push(`Found ${uniqueUrls.length} unique images to process.`);

      const urlMap = {};
      if (uniqueUrls.length > 0) {
        const CONCURRENCY_LIMIT = 30; // Process 30 images at a time
        let i = 0;
        const workers = Array(CONCURRENCY_LIMIT).fill(null).map(async () => {
          while (i < uniqueUrls.length) {
            const index = i++;
            const url = uniqueUrls[index];
            try {
              const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
              const public_id = `${folderPath}/${getPublicId(url)}_${uuidv4().slice(0, 8)}`;
              
              const uploadOptions = { public_id, overwrite: false, resource_type: 'image', use_filename: true };
              if (imageEffect) {
                uploadOptions.transformation = [{ effect: imageEffect }];
              }

              const result = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                  uploadOptions,
                  (err, res) => {
                    if (err) reject(err);
                    else resolve(res);
                  }
                );
                uploadStream.end(response.data);
              });
              
              urlMap[url] = result.secure_url;
              job.stats.success++;
            } catch (err) {
              const errMsg = cloudinaryErrMsg(err);
              urlMap[url] = url; // Keep original
              job.stats.failed++;
              
              let context = '';
              if (err.isAxiosError) {
                context = `[Download Failed] HTTP ${err.response?.status || 'Unknown'}`;
              } else {
                context = `[Cloudinary Upload Failed]`;
              }
              
              job.logs.push(`Failed to process ${url}: ${context} - ${errMsg}`);
            }
          }
        });
        await Promise.all(workers);
      }

      // PASS 2: Replace URLs and write to result file
      job.logs.push('Pass 2: Generating final CSV dataset...');
      const outputStream = fs.createWriteStream(job.resultPath);
      const stringifier = stringify({ header: true });
      
      const parser2 = fs.createReadStream(filePath).pipe(parse({ 
        columns: true, 
        skip_empty_lines: true, 
        relax_quotes: true,
        trim: true 
      }));

      stringifier.pipe(outputStream);

      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const oldUrls = Object.keys(urlMap);
      let urlRegex;
      if (oldUrls.length > 0) {
        // Sort by length descending to match longer URLs first
        oldUrls.sort((a, b) => b.length - a.length);
        const pattern = oldUrls.map(escapeRegExp).join('|');
        urlRegex = new RegExp(pattern, 'g');
      }

      for await (const record of parser2) {
        if (urlRegex) {
          htmlFields.forEach(field => {
            if (record[field] && record[field].includes('http')) {
              record[field] = record[field].replace(urlRegex, (match) => urlMap[match]);
            }
          });
        }
        stringifier.write(record);
      }
      stringifier.end();

      await new Promise((resolve, reject) => {
        outputStream.on('finish', resolve);
        outputStream.on('error', reject);
      });

      job.status = 'done';
      job.logs.push('Migration completed successfully.');
    } catch (err) {
      job.status = 'fatal';
      const errMsg = cloudinaryErrMsg(err);
      job.error = errMsg;
      job.logs.push(`Fatal Error: ${errMsg}`);
    } finally {
      // Cleanup uploaded file
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  })();

  return jobId;
}

app.post('/api/process', (req, res, next) => {
  console.log(`[POST /api/process] Content-Length: ${req.headers['content-length']}`);
  upload.single('csv')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error(`[Multer Error] ${err.message}`);
      return res.status(413).json({ error: `File too large or invalid: ${err.message}` });
    } else if (err) {
      console.error(`[Upload Error] ${err.message}`);
      return res.status(500).json({ error: `Upload failed: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  console.log(`[POST /api/process] File received: ${req.file?.originalname} (${req.file?.size} bytes)`);
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER;

  if (!cloud_name || !api_key || !api_secret) {
    return res.status(400).json({ error: 'Cloudinary credentials missing in server .env file' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  try {
    const jobId = await startProcessing(req.file.path, req.file.originalname, req.body.effect);
    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start processing: ' + err.message });
  }
});

app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send('Job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let lastLogIndex = 0;
  
  // Simple SSE implementation
  const interval = setInterval(() => {
    const newLogs = job.logs.slice(lastLogIndex);
    lastLogIndex = job.logs.length;

    res.write(`data: ${JSON.stringify({ 
      status: job.status, 
      stats: job.stats, 
      logs: newLogs,
      error: job.error 
    })}\n\n`);

    if (job.status === 'done' || job.status === 'fatal') {
      clearInterval(interval);
      res.end();
    }
  }, 1000);
});

app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job || job.status !== 'done' || !job.resultPath) return res.status(404).send('Job not found or not done');

  if (!fs.existsSync(job.resultPath)) {
    return res.status(404).send('Result file not found on server');
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=questions_migrated.csv');
  
  const stream = fs.createReadStream(job.resultPath);
  stream.pipe(res);

  // Optional: cleanup result file after some time or after download
  // For now, we keep it so the user can download multiple times if needed.
});

// Cleanup old result files every hour
setInterval(() => {
  const dir = './uploads';
  if (!fs.existsSync(dir)) return;
  
  const files = fs.readdirSync(dir);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs > oneHour) {
      fs.unlinkSync(filePath);
      console.log(`[Cleanup] Deleted old file: ${file}`);
    }
  });
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
