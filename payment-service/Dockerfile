FROM node:20-slim AS base
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN npm install --omit=dev

FROM base AS build
COPY package.json /app/
RUN npm install
COPY . /app
RUN npm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
RUN npx playwright install --with-deps chromium
COPY --from=build /app/dist /app/dist
CMD [ "node", "./dist/src/main.js" ]

# docker build -t registry.gitlab.com/nhayhoc/payment-service:acb-test . && docker push registry.gitlab.com/nhayhoc/payment-service:acb-test