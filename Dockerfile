FROM node:20-alpine AS builder

WORKDIR /squid

ADD package.json .
ADD package-lock.json .
RUN npm ci

ADD tsconfig.json .
ADD src src
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /squid

RUN apk add --no-cache python3 make g++

ADD package.json .
ADD package-lock.json .
RUN npm ci --omit=dev

ADD schema.graphql .
COPY --from=builder /squid/lib lib
ADD db db
ADD abi abi
ADD assets assets
ADD commands.json .

ENV PROCESSOR_PROMETHEUS_PORT 3000
