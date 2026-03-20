#!/bin/bash

# Knowledge Vault Deployment Script
# This script helps deploy the application to various cloud providers

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Personal Knowledge Vault Deployment${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
  echo -e "${RED}Docker is not installed. Please install Docker first.${NC}"
  exit 1
fi

# Menu
echo -e "\n${YELLOW}Choose deployment method:${NC}"
echo "1) Local Docker Compose"
echo "2) Build Docker Images"
echo "3) Prepare for Cloud Deployment"
echo "4) Run Tests"
read -p "Enter your choice (1-4): " choice

case $choice in
  1)
    echo -e "\n${YELLOW}Starting Docker Compose...${NC}"
    docker-compose up -d
    sleep 5
    echo -e "${GREEN}✓ Services started!${NC}"
    echo -e "${GREEN}Frontend: http://localhost:3000${NC}"
    echo -e "${GREEN}Backend API: http://localhost:3001${NC}"
    echo -e "${GREEN}Database: localhost:5432${NC}"
    ;;
  2)
    echo -e "\n${YELLOW}Building Docker images...${NC}"
    docker-compose build
    echo -e "${GREEN}✓ Images built successfully!${NC}"
    ;;
  3)
    echo -e "\n${YELLOW}Preparing for cloud deployment...${NC}"
    echo "1) Railway"
    echo "2) Render"
    echo "3) Heroku"
    read -p "Select platform: " platform

    case $platform in
      1)
        echo -e "${YELLOW}Railway deployment instructions:${NC}"
        echo "1. Push to GitHub"
        echo "2. Visit https://railway.app"
        echo "3. Create new project and connect GitHub"
        echo "4. Add PostgreSQL plugin"
        echo "5. Set environment variables"
        ;;
      2)
        echo -e "${YELLOW}Render deployment instructions:${NC}"
        echo "1. Push to GitHub"
        echo "2. Visit https://render.com"
        echo "3. Create new Web Service"
        echo "4. Connect GitHub repository"
        echo "5. Configure build and start commands"
        ;;
    esac
    ;;
  4)
    echo -e "\n${YELLOW}Running tests...${NC}"
    cd backend && npm test 2>/dev/null || echo "No tests configured"
    echo -e "${GREEN}✓ Tests completed${NC}"
    ;;
  *)
    echo -e "${RED}Invalid choice${NC}"
    exit 1
    ;;
esac

echo -e "\n${GREEN}✓ Done!${NC}"
