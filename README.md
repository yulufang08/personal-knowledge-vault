# 个人知识库系统 (Personal Knowledge Vault)

一款功能完整的个人知识管理系统，帮助用户高效收集、整理并动态管理个人知识。

## 核心功能

✅ **内容收集** - 浏览器剪藏插件、文件导入
✅ **Markdown编辑** - 富文本编辑器、实时预览
✅ **标签与分类** - 多维索引、快速检索
✅ **双向链接** - 内部链接、知识图谱视图
✅ **全文搜索** - 关键词搜索、结果高亮
✅ **版本历史** - 编辑历史、版本回滚
✅ **导入导出** - Markdown互操作、数据备份
✅ **权限控制** - 端到端加密、访问管理
✅ **离线体验** - PWA应用、离线使用
✅ **AI辅助** - 自动摘要、智能标签、智能问答

## 技术栈

- **后端**: Node.js + Express + PostgreSQL
- **前端**: React 18 + TypeScript + TailwindCSS
- **搜索**: SQLite FTS5 + Elasticsearch（可选）
- **部署**: Docker + Railway/Vercel

## 快速开始

### 1. 本地开发

```bash
# 克隆项目
git clone <repo-url>
cd personal-knowledge-vault

# 后端开发
cd backend
npm install
npm run dev

# 前端开发（新终端）
cd frontend
npm install
npm run dev

# 访问 http://localhost:3000
```

### 2. Docker部署

```bash
# 构建镜像
docker-compose build

# 运行服务
docker-compose up -d

# 访问 http://localhost:8080
```

### 3. 云端部署

详见 `deployment/` 目录的部署指南。

## 项目结构

```
personal-knowledge-vault/
├── backend/                 # Node.js后端服务
│   ├── src/
│   │   ├── api/            # 路由定义
│   │   ├── services/       # 业务逻辑
│   │   ├── models/         # 数据模型
│   │   ├── middleware/     # 中间件
│   │   ├── utils/          # 工具函数
│   │   └── server.ts       # 入口点
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/                # React前端应用
│   ├── src/
│   │   ├── components/     # UI组件
│   │   ├── pages/          # 页面
│   │   ├── services/       # API服务
│   │   ├── hooks/          # 自定义Hook
│   │   ├── store/          # 状态管理
│   │   ├── types/          # TypeScript类型
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── Dockerfile
├── extension/               # 浏览器插件
│   ├── src/
│   │   ├── popup.html
│   │   ├── popup.tsx
│   │   ├── content.ts
│   │   ├── background.ts
│   │   └── icons/
│   ├── manifest.json
│   └── package.json
├── deployment/              # 部署配置
│   ├── docker-compose.yml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   ├── nginx.conf
│   ├── railway.yml
│   └── vercel.json
├── docs/                    # 文档
│   ├── ARCHITECTURE.md      # 架构设计
│   ├── API.md               # API文档
│   ├── DATABASE.md          # 数据库设计
│   └── DEPLOYMENT.md        # 部署指南
└── README.md
```

## 数据库设计

### 核心表

- **users** - 用户表
- **notes** - 笔记表
- **tags** - 标签表
- **note_tags** - 笔记-标签关系
- **note_links** - 笔记链接关系
- **note_versions** - 版本历史
- **attachments** - 附件

## API端点

### 笔记管理
- `GET /api/notes` - 获取笔记列表
- `POST /api/notes` - 创建笔记
- `GET /api/notes/:id` - 获取笔记详情
- `PUT /api/notes/:id` - 更新笔记
- `DELETE /api/notes/:id` - 删除笔记
- `GET /api/notes/:id/versions` - 获取版本历史
- `POST /api/notes/:id/versions/:versionId/restore` - 恢复版本

### 标签管理
- `GET /api/tags` - 获取所有标签
- `POST /api/tags` - 创建标签
- `DELETE /api/tags/:id` - 删除标签

### 搜索
- `GET /api/search` - 全文搜索
- `GET /api/search/semantic` - 语义搜索

### 知识图谱
- `GET /api/graph` - 获取知识图谱数据
- `GET /api/notes/:id/links` - 获取笔记链接

## 特性亮点

### 1. 智能链接识别
支持 `[[文档名]]` 语法自动创建双向链接，维护完整的知识网络。

### 2. 高性能搜索
集成全文索引引擎，支持关键词搜索和语义搜索，毫秒级响应。

### 3. 版本控制
自动记录编辑历史，支持版本比对和一键回滚。

### 4. 数据隐私
支持端到端加密存储，用户可选择本地部署确保数据可控。

### 5. 跨平台同步
Web、移动端、离线模式完美同步，知识随身携带。

### 6. AI增强能力
集成Claude API进行内容摘要、标签推荐、智能问答。

## 部署状态

### 开发环境
- 本地开发服务已启动
- 前端: http://localhost:3000
- 后端API: http://localhost:3001

### 生产环境
部署链接将在完成后更新。

## 许可证

MIT

## 贡献

欢迎提交问题和拉取请求！

---

**开发者**: Claude Code
**最后更新**: 2026-03-20
