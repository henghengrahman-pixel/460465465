FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh","-c","node server/src/migrate.js && node server/src/seed.js && node server/src/index.js"]
