const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3456;

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
  res.json({ status: 'ok', message: 'ApexClips H264 server v3' });
});

// Download video then re-encode to H264 so browser can always play it
app.post('/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  const jobId = uuidv4();
  const rawPath = path.join(DOWNLOAD_DIR, `${jobId}_raw`);
  const outputFileName = `${jobId}.mp4`;
  const outputPath = path.join(DOWNLOAD_DIR, outputFileName);

  // Use best available format - no codec/extension restrictions so YouTube doesn't block it
  const downloadCmd = `yt-dlp --no-check-certificates -f "bestvideo[height<=720]+bestaudio/best[height<=720]/best" -o "${rawPath}.%(ext)s" "${url}"`;

  console.log(`[DOWNLOAD] Starting: ${url}`);

  exec(downloadCmd, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[DOWNLOAD ERROR] ${err.message}`);
      console.error(`[STDERR] ${stderr}`);
      return res.status(500).json({ success: false, error: err.message });
    }

    // Find the downloaded raw file (could be .webm, .mkv, .mp4, .av1, anything)
    const allFiles = fs.readdirSync(DOWNLOAD_DIR);
    const rawFile = allFiles.find(f => f.startsWith(`${jobId}_raw`));
    if (!rawFile) {
      return res.status(500).json({ success: false, error: 'Download failed, file not found' });
    }

    const rawFilePath = path.join(DOWNLOAD_DIR, rawFile);
    console.log(`[DOWNLOAD] Raw file: ${rawFile} — now re-encoding to H264...`);

    // Force H264 video + AAC audio — the only format all browsers can play natively
    const encodeCmd = `ffmpeg -i "${rawFilePath}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -y "${outputPath}"`;

    exec(encodeCmd, { timeout: 600000 }, (encErr, encOut, encStderr) => {
      // Always delete raw file
      try { fs.unlinkSync(rawFilePath); } catch (_) {}

      if (encErr) {
        console.error(`[ENCODE ERROR] ${encErr.message}`);
        console.error(`[ENCODE STDERR] ${encStderr}`);
        return res.status(500).json({ success: false, error: 'H264 encoding failed: ' + encErr.message });
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
        return res.status(500).json({ success: false, error: 'Encoded file missing or empty' });
      }

      const fileUrl = `${getBaseUrl(req)}/downloads/${outputFileName}`;
      const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
      console.log(`[DOWNLOAD] Done. H264 file: ${outputFileName} (${sizeMB}MB)`);
      res.json({ success: true, jobId, fileName: outputFileName, fileUrl });
    });
  });
});

// Trim a clip — always re-encode to H264
app.post('/trim', (req, res) => {
  const { fileName, start_time, end_time } = req.body;

  if (!fileName || start_time === undefined || end_time === undefined) {
    return res.status(400).json({ success: false, error: 'fileName, start_time, end_time required' });
  }

  const inputPath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ success: false, error: 'Source file not found: ' + fileName });
  }

  const jobId = uuidv4();
  const outputFileName = `clip_${jobId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);
  const duration = Math.max(1, end_time - start_time);

  // Always force H264 + AAC + yuv420p — guaranteed browser playback
  const cmd = `ffmpeg -ss ${start_time} -i "${inputPath}" -t ${duration} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -avoid_negative_ts make_zero -y "${outputPath}"`;

  console.log(`[TRIM] ${fileName} ${start_time}s → ${end_time}s (${duration}s)`);

  exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[TRIM ERROR] ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 500) {
      return res.status(500).json({ success: false, error: 'Trim output empty or missing' });
    }

    const fileUrl = `${getBaseUrl(req)}/files/${outputFileName}`;
    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
    console.log(`[TRIM] Done: ${outputFileName} (${sizeMB}MB)`);
    res.json({ success: true, jobId, fileName: outputFileName, fileUrl });
  });
});

// Extract audio for transcription (Whisper-optimized)
app.post('/extract-audio', (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ success: false, error: 'fileName required' });

  const inputPath = path.join(DOWNLOAD_DIR, fileName);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ success: false, error: 'File not found: ' + fileName });
  }

  const jobId = uuidv4();
  const audioFileName = `audio_${jobId}.mp3`;
  const audioPath = path.join(OUTPUT_DIR, audioFileName);

  const cmd = `ffmpeg -i "${inputPath}" -vn -acodec mp3 -ab 64k -ar 16000 -ac 1 -y "${audioPath}"`;

  console.log(`[AUDIO] Extracting from: ${fileName}`);

  exec(cmd, { timeout: 120000 }, (error) => {
    if (error) {
      console.error(`[AUDIO ERROR] ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }

    const fileUrl = `${getBaseUrl(req)}/files/${audioFileName}`;
    const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(2);
    console.log(`[AUDIO] Done: ${audioFileName} (${sizeMB}MB)`);
    res.json({ success: true, jobId, fileName: audioFileName, fileUrl });
  });
});

// Get video info
app.post('/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url required' });

  const cmd = `yt-dlp --no-check-certificates --dump-json "${url}"`;
  console.log(`[INFO] ${url}`);

  exec(cmd, { timeout: 30000 }, (error, stdout) => {
    if (error) return res.status(500).json({ success: false, error: error.message });
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
    name: f, url: `${base}/downloads/${f}`,
    size: fs.statSync(path.join(DOWNLOAD_DIR, f)).size,
  }));
  const outputs = fs.readdirSync(OUTPUT_DIR).map(f => ({
    name: f, url: `${base}/files/${f}`,
    size: fs.statSync(path.join(OUTPUT_DIR, f)).size,
  }));
  res.json({ downloads, outputs });
});

// Delete a file
app.delete('/delete', (req, res) => {
  const { fileName, folder = 'downloads' } = req.body;
  const dir = folder === 'output' ? OUTPUT_DIR : DOWNLOAD_DIR;
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

app.listen(PORT, () => {
  console.log(`ApexClips server v3 running on port ${PORT}`);
});
