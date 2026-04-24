const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3456;

// Use /tmp for cloud (Railway doesn't allow writing outside /tmp)
const DOWNLOAD_DIR = '/tmp/downloads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

app.use('/files', express.static(OUTPUT_DIR));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'ApexClips H264 server v2' });
});

// Download video - max 720p
app.post('/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const jobId = uuidv4();
  const outputPath = path.join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  const cmd = `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best" -o "${outputPath}" "${url}"`;

  console.log(`[DOWNLOAD] Starting: ${url}`);

  exec(cmd, { timeout: 180000 }, (error) => {
    if (error) {
      console.error(`[DOWNLOAD ERROR] ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(jobId));
    if (files.length === 0) {
      return res.status(500).json({ success: false, error: 'Download failed, file not found' });
    }

    const fileName = files[0];
    const fileUrl = `${getBaseUrl(req)}/downloads/${fileName}`;
    console.log(`[DOWNLOAD] Done: ${fileName}`);
    res.json({ success: true, jobId, fileName, fileUrl });
  });
});

// Trim video - copy first, fallback to re-encode
app.post('/trim', (req, res) => {
  const { fileName, start_time, end_time } = req.body;

  if (!fileName || start_time === undefined || end_time === undefined) {
    return res.status(400).json({ success: false, error: 'fileName, start_time, end_time are required' });
  }

  const inputPath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ success: false, error: 'Source file not found: ' + fileName });
  }

  const jobId = uuidv4();
  const outputFileName = `clip_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);
  const duration = end_time - start_time;

  const cmdCopy = `ffmpeg -ss ${start_time} -i "${inputPath}" -t ${duration} -c copy -avoid_negative_ts make_zero -y "${outputPath}"`;
  const cmdFallback = `ffmpeg -ss ${start_time} -i "${inputPath}" -t ${duration} -vf "scale=-2:720" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k -threads 2 -y "${outputPath}"`;

  console.log(`[TRIM] ${fileName} from ${start_time}s to ${end_time}s`);

  exec(cmdCopy, { timeout: 120000 }, (error) => {
    if (error || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      console.log(`[TRIM] Copy failed, trying re-encode fallback...`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

      exec(cmdFallback, { timeout: 300000 }, (err2) => {
        if (err2) {
          console.error(`[TRIM ERROR] ${err2.message}`);
          return res.status(500).json({ success: false, error: err2.message });
        }
        const fileUrl = `${getBaseUrl(req)}/files/${outputFileName}`;
        console.log(`[TRIM] Done (re-encoded): ${outputFileName}`);
        res.json({ success: true, jobId, fileName: outputFileName, fileUrl });
      });
    } else {
      const fileUrl = `${getBaseUrl(req)}/files/${outputFileName}`;
      console.log(`[TRIM] Done (copy): ${outputFileName}`);
      res.json({ success: true, jobId, fileName: outputFileName, fileUrl });
    }
  });
});

// Extract audio for transcription
app.post('/extract-audio', (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ success: false, error: 'fileName is required' });

  const inputPath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ success: false, error: 'File not found: ' + fileName });
  }

  const jobId = uuidv4();
  const audioFileName = `audio_${jobId}.mp3`;
  const audioPath = path.join(OUTPUT_DIR, audioFileName);

  // Mono 16kHz - perfect for Whisper, small file size
  const cmd = `ffmpeg -i "${inputPath}" -vn -acodec mp3 -ab 64k -ar 16000 -ac 1 -y "${audioPath}"`;

  console.log(`[AUDIO] Extracting from: ${fileName}`);

  exec(cmd, { timeout: 120000 }, (error) => {
    if (error) {
      console.error(`[AUDIO ERROR] ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }

    const fileUrl = `${getBaseUrl(req)}/files/${audioFileName}`;
    const fileSize = fs.statSync(audioPath).size;
    console.log(`[AUDIO] Done: ${audioFileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);
    res.json({ success: true, jobId, fileName: audioFileName, fileUrl, fileSize });
  });
});

// Get video info
app.post('/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const cmd = `yt-dlp --dump-json "${url}"`;
  console.log(`[INFO] Fetching info: ${url}`);

  exec(cmd, { timeout: 30000 }, (error, stdout) => {
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        success: true,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        view_count: info.view_count,
        url: info.webpage_url,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Failed to parse video info' });
    }
  });
});

// List files
app.get('/files-list', (req, res) => {
  const base = getBaseUrl(req);
  const downloads = fs.readdirSync(DOWNLOAD_DIR).map(f => ({
    name: f,
    url: `${base}/downloads/${f}`,
    size: fs.statSync(path.join(DOWNLOAD_DIR, f)).size,
  }));
  const outputs = fs.readdirSync(OUTPUT_DIR).map(f => ({
    name: f,
    url: `${base}/files/${f}`,
    size: fs.statSync(path.join(OUTPUT_DIR, f)).size,
  }));
  res.json({ downloads, outputs });
});

// Delete a file
app.delete('/delete', (req, res) => {
  const { fileName, folder = 'downloads' } = req.body;
  const dir = folder === 'output' ? OUTPUT_DIR : DOWNLOAD_DIR;
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  fs.unlinkSync(filePath);
  res.json({ success: true, message: `${fileName} deleted` });
});

// Helper - get base URL dynamically from request
function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

app.listen(PORT, () => {
  console.log(`\nApexClips cloud server running on port ${PORT}`);
  console.log(`Downloads: ${DOWNLOAD_DIR}`);
  console.log(`Output:    ${OUTPUT_DIR}`);
});
