FROM node:25-alpine

WORKDIR /app

COPY . .

RUN apk add --no-cache make

RUN make install
RUN make build
RUN npm install serve -g

EXPOSE 3000

WORKDIR /app/visual

CMD [ "serve", "-s", "dist" ]