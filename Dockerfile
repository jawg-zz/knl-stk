FROM node:22-alpine
WORKDIR /app
COPY stk.js README.md ./
RUN mkdir -p /app/data
EXPOSE 3003
CMD ["node", "stk.js"]
