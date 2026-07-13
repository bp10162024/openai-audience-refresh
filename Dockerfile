FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package*.json ./
# --ignore-scripts skips the playwright-install postinstall; browsers ship in the image
RUN npm install --omit=dev --ignore-scripts
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]
