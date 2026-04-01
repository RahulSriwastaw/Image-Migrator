import express from 'express';
import compression from 'compression';
import multer from 'multer';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import dotenv from 'dotenv';
import streamifier from 'streamifier';

dotenv.config();

const app = express();

// Enable gzip compression
app.use(compression({ level: 6, threshold: 1024 }));

// Middleware
app.use((req, res, next) => {
  if (req.method === 'POST' && process.env.DEBUG === 'true') {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
  }
  next();
});

// Use memory storage instead of disk (Vercel compatible)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.use(express.json({ limit: '250MB' }));
app.use(express.urlencoded({ limit: '250MB', extended: true }));

// In-memory job storage (resets on each deployment)
const jobs = new Map();

// Helper functions
function getPublicId(url) {
  const filename = url.split('/').pop().split('.')[0];
  return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    envCreds: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
    timestamp: new Date().toISOString()
  });
});

// Generate Cloudinary upload signature (for signed uploads)
app.get('/api/upload-signature', (req, res) => {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  
  if (!cloud_name || !api_key || !api_secret) {
    return res.status(400).json({ error: 'Cloudinary credentials missing' });
  }

  try {
    // Generate timestamp in seconds (Unix epoch)
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Create signature: SHA1(api_secret + timestamp)
    const toSign = `timestamp=${timestamp}${api_secret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');
    
    res.json({ 
      signature,
      timestamp,
      api_key,
      cloud_name
    });
  } catch (err) {
    console.error('[Signature Generation Error]', err);
    res.status(500).json({ error: 'Failed to generate signature: ' + err.message });
  }
});

// Get upload configuration (unsigned uploads)
app.get('/api/upload-config', (req, res) => {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  
  if (!cloud_name) {
    return res.status(400).json({ error: 'Cloudinary credentials missing' });
  }

  res.json({ 
    cloud_name,
    uploadPreset: 'ml_default' // Default unsigned upload preset
  });
});

// Main processing function (Vercel serverless compatible)
async function startProcessing(fileBuffer, originalName, effect) {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER || 'eduhub/questions';

  const jobId = uuidv4();
  const job = {
    status: 'processing',
    stats: { total: 0, success: 0, failed: 0 },
    logs: [],
    originalName: originalName,
    resultBuffer: null,
    resultUrl: null
  };
  jobs.set(jobId, job);

  // Non-blocking processing
  (async () => {
    try {
      cloudinary.config({ cloud_name, api_key, api_secret });

      const htmlFields = [
        'question_hin', 'question_eng',
        'option1_hin', 'option2_hin', 'option3_hin', 'option4_hin', 'option5_hin',
        'option1_eng', 'option2_eng', 'option3_eng', 'option4_eng', 'option5_eng',
        'solution_hin', 'solution_eng'
      ];

      // PASS 1: Extract unique URLs
      job.logs.push('Pass 1: Analyzing dataset for images...');
      const urlSet = new Set();
      
      const csvContent = fileBuffer.toString('utf-8');
      const srcRegex = /src=["']([^"']+)["']/gi;
      
      const parser1 = parse({ 
        columns: true, 
        skip_empty_lines: true, 
        relax_quotes: true,
        trim: true 
      });

      let recordCount = 0;
      
      // Write CSV content to parser
      parser1.write(csvContent);
      parser1.end();

      for await (const record of parser1) {
        recordCount++;
        if (recordCount % 100 === 0) {
          job.logs.push(`Scanned ${recordCount} records...`);
        }
        
        htmlFields.forEach(field => {
          if (record[field] && typeof record[field] === 'string') {
            let match;
            while ((match = srcRegex.exec(record[field])) !== null) {
              const url = match[1];
              if (url && url.startsWith('http')) {
                urlSet.add(url);
              }
            }
          }
        });
      }

      const uniqueUrls = Array.from(urlSet);
      job.stats.total = uniqueUrls.length;
      job.logs.push(`✓ Found ${uniqueUrls.length} unique images to migrate.`);

      const urlMap = {};
      if (uniqueUrls.length > 0) {
        const CONCURRENCY_LIMIT = 30; // Reduced for Vercel limits
        let i = 0;
        let progressUpdate = 0;
        
        const workers = Array(CONCURRENCY_LIMIT).fill(null).map(async () => {
          while (i < uniqueUrls.length) {
            const index = i++;
            const url = uniqueUrls[index];
            try {
              const response = await axios.get(url, { 
                responseType: 'arraybuffer', 
                timeout: 15000, 
                maxRedirects: 3 
              });
              
              const public_id = `${folder}/${getPublicId(url)}_${uuidv4().slice(0, 8)}`;
              
              const uploadOptions = { 
                public_id, 
                overwrite: false, 
                resource_type: 'image', 
                use_filename: true 
              };
              
              if (effect) {
                uploadOptions.transformation = [{ effect }];
              }

              const result = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                  uploadOptions,
                  (err, res) => {
                    if (err) reject(err);
                    else resolve(res);
                  }
                );
                streamifier.createReadStream(response.data).pipe(uploadStream);
              });
              
              urlMap[url] = result.secure_url;
              job.stats.success++;
              progressUpdate++;
              
              if (progressUpdate % 5 === 0) {
                job.logs.push(`Uploaded ${job.stats.success} / ${uniqueUrls.length} images...`);
              }
            } catch (err) {
              urlMap[url] = url;
              job.stats.failed++;
              
              let context = err.isAxiosError ? 
                `[Download Failed] HTTP ${err.response?.status || 'Unknown'}` : 
                '[Cloudinary Upload Failed]';
              
              if (index < 3 || (index + 1) === uniqueUrls.length) {
                job.logs.push(`⚠ Failed: ${url.substring(0, 50)}... - ${context}`);
              }
            }
          }
        });
        
        await Promise.all(workers);
        job.logs.push(`✓ Image migration complete: ${job.stats.success} success, ${job.stats.failed} failed.`);
      }

      // PASS 2: Replace URLs and generate result CSV
      job.logs.push('Pass 2: Generating final CSV dataset...');
      
      const parser2 = parse({ 
        columns: true, 
        skip_empty_lines: true, 
        relax_quotes: true,
        trim: true 
      });

      parser2.write(csvContent);
      parser2.end();

      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const oldUrls = Object.keys(urlMap);
      let urlRegex;
      
      if (oldUrls.length > 0) {
        oldUrls.sort((a, b) => b.length - a.length);
        const pattern = oldUrls.map(escapeRegExp).join('|');
        urlRegex = new RegExp(pattern, 'g');
      }

      const records = [];
      
      for await (const record of parser2) {
        if (urlRegex) {
          htmlFields.forEach(field => {
            if (record[field] && record[field].includes('http')) {
              record[field] = record[field].replace(urlRegex, (match) => urlMap[match]);
            }
          });
        }
        records.push(record);
      }

      // Convert records to CSV string (in-memory)
      let csvOutput = '';
      
      if (records.length > 0) {
        const keys = Object.keys(records[0]);
        csvOutput = keys.join(',') + '\n';
        
        records.forEach(record => {
          const values = keys.map(key => {
            const val = record[key] || '';
            // Escape quotes and wrap in quotes if contains comma
            const escaped = String(val).replace(/"/g, '""');
            return escaped.includes(',') ? `"${escaped}"` : escaped;
          });
          csvOutput += values.join(',') + '\n';
        });
      }

      job.resultBuffer = Buffer.from(csvOutput, 'utf-8');
      job.status = 'done';
      job.logs.push('✓ Migration completed successfully.');
    } catch (err) {
      job.status = 'fatal';
      job.error = cloudinaryErrMsg(err);
      job.logs.push(`Fatal Error: ${job.error}`);
    }
  })();

  return jobId;
}

// Direct upload endpoint (small files)
app.post('/api/process', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  if (!cloud_name || !api_key || !api_secret) {
    return res.status(400).json({ error: 'Cloudinary credentials missing' });
  }

  try {
    const jobId = await startProcessing(req.file.buffer, req.file.originalname, req.body.effect);
    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start processing: ' + err.message });
  }
});

// Process CSV from Cloudinary URL (Vercel serverless compatible - NO file uploads)
app.post('/api/process-url', express.json(), async (req, res) => {
  const { csvUrl, fileName, effect } = req.body;
  
  if (!csvUrl) {
    return res.status(400).json({ error: 'Missing csvUrl' });
  }

  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  if (!cloud_name || !api_key || !api_secret) {
    return res.status(400).json({ error: 'Cloudinary credentials missing' });
  }

  try {
    // Download CSV from URL
    const response = await axios.get(csvUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });
    
    const fileBuffer = Buffer.from(response.data);
    const jobId = await startProcessing(fileBuffer, fileName || 'dataset.csv', effect);
    res.json({ jobId });
  } catch (err) {
    console.error('[CSV Download Error]', err);
    res.status(500).json({ error: 'Failed to download CSV from Cloudinary: ' + err.message });
  }
});

// Progress endpoint (polling-based, Vercel compatible)
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({ 
    status: job.status, 
    stats: job.stats, 
    logs: job.logs,
    error: job.error 
  });
});

// Download result
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== 'done' || !job.resultBuffer) {
    return res.status(404).json({ error: 'Job not found or not completed' });
  }

  let downloadFilename = 'migrated.csv';
  if (job.originalName) {
    const ext = job.originalName.split('.').pop();
    const nameWithoutExt = job.originalName.replace(`.${ext}`, '');
    downloadFilename = `${nameWithoutExt}-IM.${ext}`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
  res.send(job.resultBuffer);
});

// API health check endpoint
app.get('/api', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'Image Migrator API ready',
    endpoints: [
      'POST /api/process - Upload and process CSV (small files)',
      'POST /api/process-url - Process CSV from Cloudinary URL (recommended)',
      'GET /api/upload-signature - Generate signed upload signature',
      'GET /api/upload-config - Get upload configuration',
      'GET /api/progress/:jobId - Check job status (polling)',
      'GET /api/download/:jobId - Download result CSV',
      'GET /api/health - Health check'
    ]
  });
});

// Root route - API info
app.get('/', (req, res) => {
  res.json({ 
    ok: true,
    message: 'Image Migrator API',
    version: '1.0.0',
    mode: 'Vercel Serverless Compatible'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Local development server
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚡ Server running at http://localhost:${PORT} (Vercel-Compatible Mode)`);
  });
}

// Export for Vercel
export default app;
