FROM node:23

WORKDIR /app

COPY ./ ./

RUN npm install \
 && npm run build

ENTRYPOINT ["npm", "start"]
