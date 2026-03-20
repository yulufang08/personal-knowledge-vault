# 快速开始指南 - 个人知识库系统

## 📚 项目介绍

个人知识库系统（Personal Knowledge Vault）是一款功能完整的个人知识管理平台，帮助您：

✅ 快速收集网页、文档、笔记
✅ 用Markdown编辑和组织知识
✅ 通过标签、分类进行多维管理
✅ 创建笔记间的双向链接
✅ 全文搜索和语义检索
✅ 知识图谱可视化
✅ 版本历史和恢复
✅ 数据导入导出

---

## 🚀 5分钟快速部署

### 本地运行 (推荐开发)

#### 1. 系统要求
- Node.js 20+
- PostgreSQL 15+ 或 Docker

#### 2. 克隆项目
```bash
git clone <项目URL>
cd personal-knowledge-vault
```

#### 3. 使用 Docker Compose (最简单)
```bash
# 一条命令启动所有服务
docker-compose up --build

# 等待服务启动完成（约30秒）
# 然后访问：
# 📱 前端应用: http://localhost:3000
# 🔌 后端API: http://localhost:3001
# 🗄️ 数据库: localhost:5432
```

#### 4. 本地开发（不用Docker）

**终端1 - 后端**
```bash
cd backend
npm install
npm run dev
# 服务运行在 http://localhost:3001
```

**终端2 - 前端**
```bash
cd frontend
npm install
npm run dev
# 应用运行在 http://localhost:3000
```

---

## ☁️ 云端部署 (选择一个)

### 方案 A: Vercel (前端) + Railway (后端)

#### Step 1: 部署后端到Railway
1. 访问 [Railway.app](https://railway.app)
2. 使用GitHub账号登录
3. 新建项目 "New Project" → "Deploy from GitHub"
4. 选择这个仓库
5. 在环境变量添加：
   ```
   NODE_ENV=production
   PORT=3001
   JWT_SECRET=your-super-secret-key-here
   ```
6. Railway会自动添加PostgreSQL，记下数据库URL
7. 等待部署完成，获得后端URL，如：`https://your-api.railway.app`

#### Step 2: 部署前端到Vercel
1. 访问 [Vercel.com](https://vercel.com)
2. 使用GitHub账号登录
3. "Import Project" → 选择这个仓库
4. 在环境变量添加：
   ```
   VITE_API_URL=https://your-api.railway.app
   ```
5. 点击 Deploy
6. 等待部署完成，获得前端URL，如：`https://knowledge-vault.vercel.app`

### 方案 B: 部署到 Render

1. 访问 [Render.com](https://render.com)
2. 使用GitHub账号登录
3. New → Web Service
4. 选择这个仓库
5. 配置：
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment: Node
6. 在环境变量添加数据库和其他配置
7. 点击 "Create Web Service"
8. 等待部署完成

### 方案 C: 阿里云/腾讯云 (中国用户)

#### 阿里云 ACR + ECS
1. 登录阿里云控制台
2. 创建容器镜像库
3. 推送Docker镜像：
   ```bash
   docker build -t your-registry/knowledge-vault:latest .
   docker push your-registry/knowledge-vault:latest
   ```
4. 在ECS创建实例，拉取镜像运行

#### 腾讯云 TCR + CVM
类似阿里云流程，使用腾讯云的容器镜像服务

---

## 📋 环境变量配置

### 必需
```env
NODE_ENV=production
PORT=3001
JWT_SECRET=your-secret-key  # 必须修改！

DB_USER=postgres
DB_PASSWORD=your-password
DB_HOST=database-host
DB_PORT=5432
DB_NAME=knowledge_vault

VITE_API_URL=http://your-api-url  # 前端使用
```

### 可选
```env
OPENAI_API_KEY=  # 用于AI功能
CLAUDE_API_KEY=
```

---

## 🧪 验证部署

访问应用后，测试以下功能：

### 1. 创建笔记
- [x] 点击"New Note"按钮
- [x] 输入标题和内容
- [x] 点击"Save"保存

### 2. 搜索
- [x] 在搜索框输入关键词
- [x] 查看搜索结果

### 3. 标签管理
- [x] 在编辑时添加标签
- [x] 在所有标签中查看

### 4. 知识图谱
- [x] 访问"Graph"视图
- [x] 查看笔记连接关系

---

## 🔧 故障排除

### 端口已被占用
```bash
# Linux/Mac
lsof -i :3000
kill -9 <PID>

# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### 数据库连接错误
- 检查数据库是否运行
- 验证.env中的数据库凭证
- 查看日志：`docker-compose logs postgres`

### 前端无法连接后端
- 检查后端是否运行（`http://localhost:3001/api/health`）
- 检查CORS配置
- 查看浏览器开发者工具的Network标签

### Docker镜像构建失败
```bash
# 清除缓存并重试
docker system prune -a
docker-compose build --no-cache
```

---

## 📊 项目统计

| 组件 | 行数 | 描述 |
|------|------|------|
| 后端 | ~500 | Node.js + Express + PostgreSQL |
| 前端 | ~400 | React + TypeScript + Zustand |
| 配置 | ~200 | Docker, Nginx, Deployment |
| 总计 | ~1100+ | 完整的全栈应用 |

---

## 🎯 主要功能

### MVP (已完成)
- ✅ 笔记增删改查
- ✅ Markdown编辑
- ✅ 标签管理
- ✅ 全文搜索
- ✅ 双向链接
- ✅ 知识图谱

### 计划功能 (V2)
- 🔄 浏览器剪藏插件
- 🔄 AI自动摘要和标签
- 🔄 多人协作
- 🔄 移动端应用
- 🔄 离线模式

---

## 💡 使用建议

### 建立知识结构
1. 先分类创建主题笔记（如"编程语言"、"项目管理"）
2. 用 `[[链接]]` 创建相关笔记间的联系
3. 使用一致的标签体系
4. 定期查看知识图谱，发现关联

### 性能优化
- 定期导出备份数据
- 清理过期笔记
- 使用标签而非复杂的分类
- 对大量文件使用压缩

### 隐私保护
- 更改默认密码和JWT密钥
- 配置数据库加密
- 定期更新依赖包
- 使用HTTPS部署

---

## 📚 详细文档

- [部署指南](./docs/DEPLOYMENT.md)
- [架构设计](./docs/ARCHITECTURE.md)
- [API文档](./docs/API.md)
- [数据库设计](./docs/DATABASE.md)

---

## 🤝 贡献

欢迎提交Issue和Pull Request！

---

## 📞 支持

- 📖 查看文档
- 🐛 提交问题
- 💬 讨论功能
- 🌟 Star项目表示支持

---

## 📄 许可证

MIT License - 自由使用和修改

---

**部署成功！🎉 享受您的个人知识库！**

> 提示：首次使用可能需要加载一些资源，请耐心等待。建议在浏览器开发者工具中查看网络和控制台，排查任何问题。
