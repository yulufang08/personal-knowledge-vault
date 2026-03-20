FROM node:20-alpine AS builder

WORKDIR /app

# 复制所有文件
COPY . .

# 安装所有依赖（包括dev）用于构建
RUN cd backend && npm install --legacy-peer-deps 2>&1

# 验证TypeScript编译
RUN cd backend && npm run build 2>&1 || (echo "Build failed, showing error details:" && cat /root/.npm/_logs/*.log || true && exit 1)

# 生产阶段
FROM node:20-alpine

WORKDIR /app

# 从builder阶段复制编译后的代码
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/package.json ./package.json

# 仅安装生产依赖
RUN npm install --legacy-peer-deps --omit=dev 2>&1

# 暴露端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})" || exit 1

# 启动应用
CMD ["node", "dist/server.js"]
