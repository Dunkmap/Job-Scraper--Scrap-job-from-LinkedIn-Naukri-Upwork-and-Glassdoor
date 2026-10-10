FROM apify/actor-node:22
COPY package*.json ./
RUN npm install --omit=dev --audit=false --fund=false && npm cache clean --force
COPY . ./
CMD ["node", "main.mjs"]
