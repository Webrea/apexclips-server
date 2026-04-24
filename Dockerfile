FROM node:20-bullseye

# Install full FFmpeg (includes libx264, libx265, all codecs) + yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install --break-system-packages yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Verify libx264 is available
RUN ffmpeg -codecs 2>/dev/null | grep -i h264 || echo "WARNING: H264 not found"
RUN ffmpeg -encoders 2>/dev/null | grep libx264 || echo "WARNING: libx264 not found"

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3456

CMD ["node", "server.js"]
