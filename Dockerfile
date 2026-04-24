FROM node:20-bullseye

# Install full FFmpeg (includes libx264) + yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3456

CMD ["node", "server.js"]
