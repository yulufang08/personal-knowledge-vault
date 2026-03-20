# Deployment Guide

## Local Development

### Prerequisites
- Node.js 20+
- Docker and Docker Compose (for containerized development)
- PostgreSQL 15+ (if not using Docker)

### Quick Start with Docker

```bash
# Clone the project
cd personal-knowledge-vault

# Build and start services
docker-compose up --build

# Access the application
# Frontend: http://localhost:3000
# Backend API: http://localhost:3001
# Database: localhost:5432
```

### Local Development (Without Docker)

#### Setup Backend
```bash
cd backend
npm install
npm run build
npm run dev
```

#### Setup Frontend (New Terminal)
```bash
cd frontend
npm install
npm run dev
```

#### Database Setup
```bash
# Create PostgreSQL database
createdb knowledge_vault

# Run migrations (if using migration tools)
npm run migrate
```

## Cloud Deployment

### Option 1: Deploy to Railway

1. Create account at [Railway.app](https://railway.app)
2. Create new project
3. Connect GitHub repository
4. Add PostgreSQL plugin
5. Set environment variables
6. Deploy

### Option 2: Deploy to Vercel + Backend on Railway

#### Frontend (Vercel)
```bash
npm install -g vercel
vercel
```

#### Backend (Railway)
See Railway deployment section above

### Option 3: Deploy to Render

1. Create account at [Render.com](https://render.com)
2. Create new Web Service
3. Connect GitHub repository
4. Configure build and start commands:
   - Build: `npm install && npm run build`
   - Start: `npm start`
5. Add PostgreSQL database
6. Deploy

## Production Checklist

- [ ] Set strong JWT_SECRET in environment
- [ ] Enable HTTPS/SSL
- [ ] Configure CORS properly
- [ ] Set up database backups
- [ ] Enable database encryption
- [ ] Configure rate limiting
- [ ] Set up monitoring/logging
- [ ] Configure auto-scaling (if needed)
- [ ] Set up CDN for static assets
- [ ] Configure firewall rules
- [ ] Enable CSRF protection
- [ ] Set strong database password

## Environment Variables

Required:
- `DATABASE_URL` or separate DB_* variables
- `JWT_SECRET`
- `NODE_ENV`

Optional:
- `VITE_API_URL` - Backend API URL for frontend
- `PORT` - Application port (default: 3001)

## Monitoring

### Logs
```bash
# Docker logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Railway logs (in dashboard)
```

### Health Checks
- Backend: GET `/api/health`
- Frontend: Available at `/`

## Scaling

### Horizontal Scaling
- Use load balancer (e.g., nginx)
- Run multiple backend instances
- Use connection pooling for database

### Vertical Scaling
- Increase container resources
- Increase database resources
- Add caching layer (Redis)

## Backup & Recovery

### Database Backup
```bash
# Backup
pg_dump knowledge_vault > backup.sql

# Restore
psql knowledge_vault < backup.sql
```

### Automated Backups
Configure in your cloud provider:
- Railway: Built-in backups
- Render: Configure backup frequency
- AWS RDS: Automated backups

## Troubleshooting

### Port Already in Use
```bash
# Linux/Mac
lsof -i :3001
kill -9 <PID>

# Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

### Database Connection Issues
- Verify credentials in .env
- Check database is running
- Verify network connectivity
- Check firewall rules

### Build Failures
- Clear node_modules: `rm -rf node_modules && npm install`
- Clear Docker cache: `docker system prune -a`
- Check Node.js version: `node --version`

## Performance Optimization

1. Enable gzip compression in nginx
2. Use CDN for static files
3. Implement caching strategies
4. Database query optimization
5. Connection pooling
6. Rate limiting
7. Image optimization

## Security

1. Use environment variables for secrets
2. Enable HTTPS/SSL
3. Implement CORS properly
4. Use strong passwords
5. Regular security updates
6. Monitor for vulnerabilities
7. Implement rate limiting
8. Use prepared statements for queries

## Support

For issues and questions:
- Check logs: `docker-compose logs -f`
- Review error messages
- Check GitHub issues
- Contact support team
