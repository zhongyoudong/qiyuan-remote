FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.mjs ./
EXPOSE 1004
CMD ["node", "server.mjs"]
