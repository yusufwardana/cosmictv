FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir data && chown node:node data
USER node
ENV HOST=0.0.0.0 PORT=8787 ADMIN_HOST=127.0.0.1 ADMIN_PORT=8788 NODE_ENV=production
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s CMD node -e "fetch('http://127.0.0.1:8787/api/v1/status').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
